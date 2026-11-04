#!/usr/bin/env bash
# Despliegue en una EC2 con Docker Compose. Uso: deploy/aws/aws.sh <comando>
#   provision        crea la EC2, su IP fija y el grupo de seguridad
#   deploy           copia el código local y levanta el stack
#   smoke            corre la verificación de punta a punta contra la URL pública
#   status           muestra estado, tipo y URL
#   resize <tipo>    cambia el tipo de instancia (la detiene un momento)
#   stop | start     apaga o enciende (apagada no paga cómputo, sí disco e IP)
#   destroy          borra todo lo creado; pide confirmación
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NAME="preconteo"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.large}"
KEY_FILE="$HOME/.ssh/$NAME-aws.pem"
KNOWN_HOSTS="$HOME/.ssh/$NAME-known-hosts"
COMPOSE="docker compose -f docker-compose.yml -f deploy/cloud/docker-compose.prod.yml"

die() { echo "Error: $*" >&2; exit 1; }

instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text | grep -v '^None$' || true
}

require_instance() {
  local id
  id="$(instance_id)"
  [[ -n "$id" ]] || die "no hay instancia; ejecute primero: deploy/aws/aws.sh provision"
  echo "$id"
}

allocation_id() {
  aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" \
    --query 'Addresses[0].AllocationId' --output text | grep -v '^None$' || true
}

public_ip() {
  aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" \
    --query 'Addresses[0].PublicIp' --output text | grep -v '^None$' || true
}

security_group_id() {
  aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" \
    --query 'SecurityGroups[0].GroupId' --output text | grep -v '^None$' || true
}

site_address() { echo "$(public_ip | tr . -).sslip.io"; }

architecture_of() {
  aws ec2 describe-instance-types --instance-types "$1" \
    --query 'InstanceTypes[0].ProcessorInfo.SupportedArchitectures[0]' --output text
}

# Ignora solo el error de que la regla ya exista.
authorize_ingress() {
  local output
  if ! output="$(aws ec2 authorize-security-group-ingress "$@" 2>&1)"; then
    [[ "$output" == *InvalidPermission.Duplicate* ]] || die "$output"
  fi
}

# SSH solo desde la IP actual de quien despliega.
allow_my_ip_ssh() {
  local my_ip
  my_ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  authorize_ingress --group-id "$(security_group_id)" --protocol tcp --port 22 --cidr "$my_ip/32"
}

remote() {
  ssh -i "$KEY_FILE" -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 "ubuntu@$(public_ip)" "$@"
}

cmd_provision() {
  [[ -z "$(instance_id)" ]] || die "ya existe una instancia; use deploy, resize o destroy"

  local architecture ami_architecture
  architecture="$(architecture_of "$INSTANCE_TYPE")"
  [[ "$architecture" == "x86_64" ]] && ami_architecture="amd64" || ami_architecture="arm64"

  local ami vpc
  ami="$(aws ssm get-parameter --query Parameter.Value --output text --name \
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/$ami_architecture/hvm/ebs-gp3/ami-id")"
  vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)"
  [[ "$vpc" != "None" ]] || die "la región $AWS_REGION no tiene VPC por defecto"

  if ! aws ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
    umask 077
    aws ec2 create-key-pair --key-name "$NAME" --query KeyMaterial --output text > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  fi
  [[ -f "$KEY_FILE" ]] || die "la llave $NAME existe en AWS pero falta $KEY_FILE"

  if [[ -z "$(security_group_id)" ]]; then
    aws ec2 create-security-group --group-name "$NAME" --vpc-id "$vpc" \
      --description "Preconteo: HTTP y HTTPS publicos, SSH restringido" >/dev/null
  fi
  local group
  group="$(security_group_id)"
  authorize_ingress --group-id "$group" --protocol tcp --port 80 --cidr 0.0.0.0/0
  authorize_ingress --group-id "$group" --protocol tcp --port 443 --cidr 0.0.0.0/0
  allow_my_ip_ssh

  local id
  id="$(aws ec2 run-instances \
    --image-id "$ami" --instance-type "$INSTANCE_TYPE" --key-name "$NAME" \
    --security-group-ids "$group" \
    --user-data "file://deploy/cloud/first-boot.sh" \
    --metadata-options HttpTokens=required \
    --block-device-mappings \
    'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)"
  echo "Instancia $id ($INSTANCE_TYPE). Esperando a que arranque..."
  aws ec2 wait instance-running --instance-ids "$id"

  if [[ -z "$(allocation_id)" ]]; then
    aws ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" >/dev/null
  fi
  aws ec2 associate-address --instance-id "$id" --allocation-id "$(allocation_id)" >/dev/null
  echo "Lista: $(public_ip). Siguiente paso: deploy/aws/aws.sh deploy"
}

cmd_deploy() {
  require_instance >/dev/null
  [[ -f .env ]] || die "falta .env; cópielo de .env.example"
  ! grep -q reemplazar .env || die ".env todavía tiene valores de ejemplo"
  allow_my_ip_ssh

  echo "Esperando SSH y el primer arranque (Docker tarda unos minutos)..."
  local attempt
  for attempt in $(seq 1 30); do
    remote true 2>/dev/null && break
    [[ "$attempt" -lt 30 ]] || die "no se pudo conectar por SSH"
    sleep 10
  done
  # Devuelve 2 si el arranque terminó con advertencias: se valida el resultado, no el código.
  remote 'cloud-init status --wait >/dev/null' || true
  remote 'command -v docker >/dev/null' || die "el primer arranque no instaló Docker"

  rsync -az --delete -e \
    "ssh -i $KEY_FILE -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=accept-new" \
    --exclude node_modules --exclude dist --exclude .git --exclude .env --exclude load/results \
    ./ "ubuntu@$(public_ip):app/"

  { cat .env; echo "SITE_ADDRESS=$(site_address)"; } |
    remote 'umask 077; cat > app/.env'

  remote "cd app && $COMPOSE up -d --build --wait --remove-orphans app lb edge"
  echo "Desplegado: https://$(site_address)"
}

cmd_smoke() {
  BASE_URL="https://$(site_address)" npm run -s smoke
}

cmd_status() {
  local id
  id="$(instance_id)"
  [[ -n "$id" ]] || { echo "No hay instancia en $AWS_REGION"; return; }
  aws ec2 describe-instances --instance-ids "$id" --output table \
    --query 'Reservations[0].Instances[0].{Id:InstanceId,Estado:State.Name,Tipo:InstanceType}'
  echo "URL: https://$(site_address)"
}

cmd_resize() {
  local new_type="${1:-}" id current
  [[ -n "$new_type" ]] || die "indique el tipo, por ejemplo: resize c7g.2xlarge"
  id="$(require_instance)"
  current="$(aws ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].InstanceType' --output text)"
  [[ "$(architecture_of "$new_type")" == "$(architecture_of "$current")" ]] ||
    die "$new_type tiene otra arquitectura que $current: habría que recrear la instancia"
  aws ec2 stop-instances --instance-ids "$id" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$id"
  aws ec2 modify-instance-attribute --instance-id "$id" --instance-type "{\"Value\":\"$new_type\"}"
  aws ec2 start-instances --instance-ids "$id" >/dev/null
  aws ec2 wait instance-running --instance-ids "$id"
  echo "Ahora es $new_type"
}

cmd_stop() {
  local id
  id="$(require_instance)"
  aws ec2 stop-instances --instance-ids "$id" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$id"
  echo "Apagada. Sigue cobrando disco e IP fija; para no pagar nada: destroy"
}

cmd_start() {
  local id
  id="$(require_instance)"
  aws ec2 start-instances --instance-ids "$id" >/dev/null
  aws ec2 wait instance-running --instance-ids "$id"
  echo "Encendida: https://$(site_address)"
}

cmd_destroy() {
  echo "Se borrarán en $AWS_REGION la instancia, sus datos, la IP fija, el grupo y la llave de '$NAME'."
  read -r -p "Escriba 'destruir' para continuar: " answer
  [[ "$answer" == "destruir" ]] || die "cancelado"

  local id allocation group
  id="$(instance_id)"
  if [[ -n "$id" ]]; then
    aws ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$id"
  fi
  allocation="$(allocation_id)"
  [[ -z "$allocation" ]] || aws ec2 release-address --allocation-id "$allocation"
  group="$(security_group_id)"
  [[ -z "$group" ]] || aws ec2 delete-security-group --group-id "$group"
  aws ec2 delete-key-pair --key-name "$NAME" >/dev/null
  rm -f "$KEY_FILE" "$KNOWN_HOSTS"
  echo "Todo borrado."
}

command="${1:-}"
[[ $# -eq 0 ]] || shift
command -v aws >/dev/null || die "falta el AWS CLI: brew install awscli"
aws sts get-caller-identity >/dev/null 2>&1 || die "sin credenciales de AWS: ejecute aws configure"

case "$command" in
  provision) cmd_provision ;;
  deploy) cmd_deploy ;;
  smoke) cmd_smoke ;;
  status) cmd_status ;;
  resize) cmd_resize "$@" ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
