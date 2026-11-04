# Preconteo electoral en tiempo real

Taller de WebSockets · Programación Orientada a la Web. Un acta que entra llega, con garantías
distintas, a jurados, auditores y público, repartidos en ocho instancias que solo se coordinan por
Redis.

## Arrancar

Requiere Docker y Node 22.

```bash
cp .env.example .env        # y reemplace los secretos: openssl rand -hex 32
npm install
npm run stack:up            # Redis + seed + 8 instancias + nginx en http://localhost:8080
npm run smoke               # verificación de punta a punta contra el stack
npm run smoke -- --chaos    # además cae Redis y mata una instancia
npm run stack:down          # apaga y BORRA los datos
```

| URL                               | Qué es                                       |
| --------------------------------- | -------------------------------------------- |
| `/` y `/?topic=mun:11`            | Página pública (SSE)                         |
| `/jurado.html`                    | App del jurado (WebSocket, funciona sin red) |
| `/como-funciona.html`             | Explicación del sistema                      |
| `/api/public/snapshot?topics=dep` | Fotografía por polling, con ETag             |
| `/api/ops/metrics`                | Métricas de todas las instancias (JSON)      |
| `/api/instance`                   | Identificador de la instancia que respondió  |

## Desarrollo

```bash
docker compose up -d --wait redis
npm test                    # unitarias + integración contra Redis real (base 15)
npm run typecheck && npm run lint
```

## Despliegue

En Azure: ver [deploy/azure/README.md](deploy/azure/README.md). También hay un script para AWS, aún sin probar en una cuenta real: [deploy/aws/README.md](deploy/aws/README.md).

## Documentación

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diseño, decisiones y respuestas a lo que pide el enunciado.
- [docs/PROMPT_COWORKER.md](docs/PROMPT_COWORKER.md): estado del proyecto y guía para continuar.
