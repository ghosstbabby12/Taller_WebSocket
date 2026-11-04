#!/usr/bin/env bash
# Despliegue en una máquina virtual de Azure con Docker Compose. Uso: deploy/azure/azure.sh <comando>
#   provision        crea el grupo de recursos, la VM, su IP fija y las reglas de red
#   deploy           copia el código local y levanta el stack
#   smoke            corre la verificación de punta a punta contra la URL pública
#   status           muestra estado, tamaño y URL
#   resize <tamaño>  cambia el tamaño de la VM (la reinicia)
#   stop | start     desasigna o enciende (desasignada no paga cómputo, sí disco e IP)
#   destroy          borra todo el grupo de recursos; pide confirmación
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NAME="preconteo"
GROUP="$NAME-rg"
ADMIN_USER="azureuser"
LOCATION="${AZURE_LOCATION:-eastus2}"
VM_SIZE="${AZURE_VM_SIZE:-Standard_B2ms}"
KEY_FILE="$HOME/.ssh/$NAME-azure"
KNOWN_HOSTS="$HOME/.ssh/$NAME-azure-known-hosts"
COMPOSE="docker compose -f docker-compose.yml -f deploy/cloud/docker-compose.prod.yml"

die() { echo "Error: $*" >&2; exit 1; }

vm_exists() { az vm show -g "$GROUP" -n "$NAME" --query id -o tsv >/dev/null 2>&1; }

require_vm() { vm_exists || die "no hay VM; ejecute primero: deploy/azure/azure.sh provision"; }

public_ip() { az network public-ip show -g "$GROUP" -n "$NAME-ip" --query ipAddress -o tsv; }

site_address() { echo "$(public_ip | tr . -).sslip.io"; }

# SSH solo desde la IP actual de quien despliega. Crear una regla existente la actualiza.
allow_my_ip_ssh() {
  local my_ip
  my_ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  az network nsg rule create -g "$GROUP" --nsg-name "$NAME-nsg" -n ssh-deployer --priority 110 \
    --access Allow --protocol Tcp --destination-port-ranges 22 \
    --source-address-prefixes "$my_ip/32" -o none
}

remote() {
  ssh -i "$KEY_FILE" -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 "$ADMIN_USER@$(public_ip)" "$@"
}

cmd_provision() {
  ! vm_exists || die "ya existe la VM; use deploy, resize o destroy"
  [[ -f "$KEY_FILE" ]] || ssh-keygen -q -t ed25519 -N '' -C "$NAME-azure" -f "$KEY_FILE"

  az group create -n "$GROUP" -l "$LOCATION" -o none
  az network nsg create -g "$GROUP" -n "$NAME-nsg" -o none
  az network nsg rule create -g "$GROUP" --nsg-name "$NAME-nsg" -n web --priority 100 \
    --access Allow --protocol Tcp --destination-port-ranges 80 443 -o none
  allow_my_ip_ssh

  echo "Creando la VM $VM_SIZE en $LOCATION..."
  az vm create -g "$GROUP" -n "$NAME" \
    --image Ubuntu2404 --size "$VM_SIZE" \
    --admin-username "$ADMIN_USER" --ssh-key-values "$KEY_FILE.pub" \
    --custom-data deploy/cloud/first-boot.sh \
    --nsg "$NAME-nsg" \
    --public-ip-address "$NAME-ip" --public-ip-sku Standard --public-ip-address-allocation static \
    --os-disk-size-gb 30 --storage-sku StandardSSD_LRS -o none
  echo "Lista: $(public_ip). Siguiente paso: deploy/azure/azure.sh deploy"
}

cmd_deploy() {
  require_vm
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
  remote 'cloud-init status --wait >/dev/null'

  rsync -az --delete -e \
    "ssh -i $KEY_FILE -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=accept-new" \
    --exclude node_modules --exclude dist --exclude .git --exclude .env --exclude load/results \
    ./ "$ADMIN_USER@$(public_ip):app/"

  { cat .env; echo "SITE_ADDRESS=$(site_address)"; } |
    remote 'umask 077; cat > app/.env'

  remote "cd app && sudo $COMPOSE up -d --build --wait --remove-orphans app lb edge"
  echo "Desplegado: https://$(site_address)"
}

cmd_smoke() {
  BASE_URL="https://$(site_address)" npm run -s smoke
}

cmd_status() {
  vm_exists || { echo "No hay VM en el grupo $GROUP"; return; }
  az vm show -d -g "$GROUP" -n "$NAME" -o table \
    --query '{Estado:powerState,Tamano:hardwareProfile.vmSize,Region:location}'
  echo "URL: https://$(site_address)"
}

cmd_resize() {
  local new_size="${1:-}"
  [[ -n "$new_size" ]] || die "indique el tamaño, por ejemplo: resize Standard_F4s_v2"
  require_vm
  az vm resize -g "$GROUP" -n "$NAME" --size "$new_size" -o none
  echo "Ahora es $new_size"
}

# deallocate y no stop: una VM solo detenida sigue cobrando el cómputo.
cmd_stop() {
  require_vm
  az vm deallocate -g "$GROUP" -n "$NAME" -o none
  echo "Desasignada. Sigue cobrando disco e IP fija; para no pagar nada: destroy"
}

cmd_start() {
  require_vm
  az vm start -g "$GROUP" -n "$NAME" -o none
  echo "Encendida: https://$(site_address)"
}

cmd_destroy() {
  echo "Se borrará el grupo de recursos '$GROUP' completo: VM, datos, IP y reglas de red."
  read -r -p "Escriba 'destruir' para continuar: " answer
  [[ "$answer" == "destruir" ]] || die "cancelado"
  az group delete -n "$GROUP" --yes
  rm -f "$KEY_FILE" "$KEY_FILE.pub" "$KNOWN_HOSTS"
  echo "Todo borrado."
}

command="${1:-}"
[[ $# -eq 0 ]] || shift
command -v az >/dev/null || die "falta el CLI de Azure: brew install azure-cli"
# Una consulta real: az account show responde con datos en caché aunque la sesión haya expirado.
az group list --query '[0].id' -o none 2>/dev/null || die "sesión de Azure inválida: ejecute az login"

case "$command" in
  provision) cmd_provision ;;
  deploy) cmd_deploy ;;
  smoke) cmd_smoke ;;
  status) cmd_status ;;
  resize) cmd_resize "$@" ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
