# Despliegue en AWS

**Sin probar en una cuenta real.** El stack de `deploy/cloud/` sí se probó en local.

Una EC2 con Ubuntu corre este mismo stack con Docker Compose: Redis, 8 instancias, nginx sin afinidad y
Caddy delante para TLS y HTTP/2. La URL es `https://<ip-con-guiones>.sslip.io`, sin comprar dominio.

Requisitos: AWS CLI con credenciales y un `.env` con secretos reales. El código sale de tu copia local,
incluidos los cambios sin commit.

| Comando                                | Qué hace                                                             |
| -------------------------------------- | -------------------------------------------------------------------- |
| `deploy/aws/aws.sh provision`          | Crea la EC2, la IP fija, el grupo de seguridad y la llave SSH        |
| `deploy/aws/aws.sh deploy`             | Copia el código y levanta el stack. Repítelo para cada actualización |
| `deploy/aws/aws.sh smoke`              | Verificación de punta a punta contra la URL pública                  |
| `deploy/aws/aws.sh status`             | Estado, tipo y URL                                                   |
| `deploy/aws/aws.sh resize c7g.2xlarge` | Cambia el tamaño, con unos minutos fuera de servicio                 |
| `deploy/aws/aws.sh stop` / `start`     | Apaga o enciende                                                     |
| `deploy/aws/aws.sh destroy`            | Borra todo, datos incluidos. Pide confirmación                       |

Variables opcionales: `AWS_REGION` (por defecto `us-east-1`) e `INSTANCE_TYPE` (por defecto `t4g.large`).

## Seguridad

- Solo los puertos 80 y 443 son públicos; SSH se abre únicamente para la IP de quien despliega.
- Redis y nginx no publican puertos en la máquina.
- La llave queda en `~/.ssh/preconteo-aws.pem`. No la subas al repo.

## Limitaciones

- Todo vive en una sola máquina: es un punto único de falla, y hay que explicarlo en el informe.
- `smoke --chaos` no funciona contra la nube, porque controla Docker local. Para RF-10 hay que ejecutar
  `docker compose stop redis` por SSH.
