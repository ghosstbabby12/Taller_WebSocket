# Despliegue en Azure

Una VM con Ubuntu corre este mismo stack con Docker Compose: Redis, 8 instancias, nginx sin afinidad y
Caddy delante para TLS y HTTP/2. La URL es `https://<ip-con-guiones>.sslip.io`, sin comprar dominio.

Requisitos: `az login` vigente y un `.env` con secretos reales. El código sale de tu copia local,
incluidos los cambios sin commit.

| Comando                                 | Qué hace                                                             |
| --------------------------------------- | -------------------------------------------------------------------- |
| `deploy/azure/azure.sh provision`       | Crea el grupo de recursos, la VM, la IP fija y las reglas de red     |
| `deploy/azure/azure.sh deploy`          | Copia el código y levanta el stack. Repítelo para cada actualización |
| `deploy/azure/azure.sh smoke`           | Verificación de punta a punta contra la URL pública                  |
| `deploy/azure/azure.sh status`          | Estado, tamaño y URL                                                 |
| `deploy/azure/azure.sh resize <tamaño>` | Cambia el tamaño, con unos minutos fuera de servicio                 |
| `deploy/azure/azure.sh stop` / `start`  | Desasigna o enciende                                                 |
| `deploy/azure/azure.sh destroy`         | Borra todo, datos incluidos. Pide confirmación                       |

Variables opcionales: `AZURE_LOCATION` (por defecto `mexicocentral`) y `AZURE_VM_SIZE` (por defecto
`Standard_B2s_v2`). Azure for Students limita las regiones (`chilecentral`, `mexicocentral`,
`belgiumcentral`, `spaincentral`, `switzerlandnorth`) y a 6 vCPU por región.

## Seguridad

- Solo los puertos 80 y 443 son públicos; SSH se abre únicamente para la IP de quien despliega.
- Redis y nginx no publican puertos en la máquina.
- La llave queda en `~/.ssh/preconteo-azure`. No la subas al repo.

## Limitaciones

- Todo vive en una sola máquina: es un punto único de falla, y hay que explicarlo en el informe.
- `smoke --chaos` no funciona contra la nube, porque controla Docker local. Para RF-10 hay que ejecutar
  `sudo docker compose stop redis` por SSH.
