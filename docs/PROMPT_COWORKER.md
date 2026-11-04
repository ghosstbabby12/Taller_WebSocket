# Guía para continuar el proyecto

Sirve de dos formas: léela como guía de trabajo, o pégala completa a tu asistente de código como prompt
inicial. Está escrita en segunda persona para ambos casos.

---

Vas a continuar el **Taller de WebSockets: transmisión y difusión de resultados en una jornada
electoral**. El enunciado es `docs/Caso de estudio.pdf`, y manda sobre este documento: léelo completo antes de
tocar código, y luego lee `docs/ARCHITECTURE.md`. La nota evalúa tres cosas: elegir el transporte
correcto **y defenderlo con mediciones propias**, un fan-out que sobreviva al pico sin bloquear el Event
Loop, y un resultado consistente y explicable cuando algo falla.

## Primeros 15 minutos

```bash
cp .env.example .env         # reemplaza los secretos
npm install
npm run stack:up             # 8 instancias + Redis + nginx en http://localhost:8080
npm test                     # debe dar 50 pruebas en verde
npm run smoke -- --chaos     # debe terminar en «Smoke OK»
```

Si algo de esto falla, arréglalo antes de seguir: todo lo demás se apoya aquí.

## Qué ya existe

| Req                  | Estado                                                   | Evidencia                                                           |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| RF-1 idempotencia    | Hecho                                                    | `test/integration/submit-acta.test.ts`, smoke                       |
| RF-2 convergencia    | Hecho                                                    | Prueba de todas las permutaciones                                   |
| RF-3 atomicidad      | Hecho                                                    | Lua; prueba municipio = suma de puestos, con escrituras simultáneas |
| RF-5 tópicos         | Hecho                                                    | `src/fanout/topic-registry.ts`                                      |
| RF-6 reconexión      | Hecho, **falta medir memoria**                           | `publication.test.ts`, smoke                                        |
| RF-4 fan-out         | Código hecho, **sin medir a escala**                     | Pruebas unitarias del envío por lotes                               |
| RF-9 contrapresión   | Política hecha, **sin demostrar con cliente lento real** | Pruebas unitarias                                                   |
| RF-10 sin Redis      | Hecho                                                    | `smoke --chaos`                                                     |
| RF-10 avalancha      | Backoff hecho, **falta la gráfica**                      | `public/js/backoff.js`                                              |
| RF-7 cola y bloqueo  | **Solo** el encolado en `submit_acta.lua`                |                                                                     |
| RF-8 presencia       | **Sin empezar**                                          |                                                                     |
| RT-2, RT-3           | Hecho                                                    | Smoke: 16 conexiones en 8 instancias                                |
| RT-6 sin red         | Hecho, con formulario real y corte real del balanceador  | Probado en Chrome                                                   |
| RT-5 transportes     | SSE y WebSocket conviven, **sin justificación medida**   |                                                                     |
| RT-4, RT-7 tablero   | La API `/api/ops/metrics` existe, **falta el panel**     |                                                                     |
| RT-1, RT-10 nube     | Desplegado en Azure, ver `deploy/azure/README.md`        | Smoke contra la URL pública                                         |
| RT-8 carga, RT-9 INP | **Sin empezar**                                          |                                                                     |

## Reglas que no se pueden romper

1. **Ninguna instancia habla con otra.** Todo pasa por Redis (RT-3).
2. **Nada de estado de sesión en memoria**, ni afinidad en nginx (RT-2). Prueba siempre con las 8.
3. **Toda escritura que toque varias claves va en un script Lua.** Nunca varios comandos seguidos.
4. **El público lee `pub:*`, nunca `tally:*`.** Si no, un cliente que reconecta vería un valor distinto.
5. **Los deltas llevan valores absolutos**, no incrementos.
6. **Nunca digas «registrada» sin saberlo.** Toda falla de Redis termina en una respuesta explícita.
7. **Ningún recorrido grande sin ceder el Event Loop.** Usa `BatchedBroadcaster`.
8. **Lo que el enunciado pide medir se mide.** Una cifra calculada no es una medición.

Estilo: TypeScript estricto, reglas puras en `domain/` sin I/O, claves solo en `redis/keys.ts`, y las
clases concretas se conectan solo en `main.ts`. Antes de cada commit: `npm run typecheck && npm run lint
&& npm test`. Prueba los scripts Lua contra Redis real, nunca con mocks.

## Tareas, en este orden

Trabaja en una rama por tarea. Cada una termina cuando se cumple su criterio.

### 1. Desplegar en la nube (RT-1, RT-10): hecho

Ya está en una VM de Azure. La máquina se apaga entre sesiones: enciéndela con
`deploy/azure/azure.sh start`. Publica cambios con `deploy/azure/azure.sh deploy`.

### 2. Prueba de carga (RT-8)

La necesitan casi todas las mediciones. Va en `load/`.

- Generador con procesos `worker` y sockets `node:http` crudos. `load/sse-client.ts` usa `fetch` y pesa
  demasiado para 20.000 conexiones.
- Corre desde **otra máquina**: en la misma, el generador compite por CPU con lo que mide. Una sola IP de
  origen da unos 28.000 puertos efímeros por destino: alcanza para 20.000, pero no mucho más.
- Perfil de la jornada con factor de compresión de tiempo: 55 % de las actas en los primeros 40 min,
  ráfagas de 300 por minuto, 4-11 % de reenvíos, unas 180 correcciones, 6-9 % de dudosas.
- Los clientes **verifican** el estado final contra la fotografía, no solo cuentan mensajes.

**Listo cuando:** un solo comando levanta 20.000 conexiones contra la URL pública y deja un resumen en
`load/results/`.

### 3. Mediciones del fan-out (RF-4, RT-4)

**Listo cuando** el informe tenga, medidos en el pico:

- retraso del Event Loop (p99 y máximo) por instancia, con lotes y sin lotes (`FANOUT_BATCH_SIZE` enorme);
- mensajes emitidos en total contra los 2.560 millones de la cifra ingenua;
- una decisión sobre la ventana de `dep`: ver la tabla de RF-4 en `ARCHITECTURE.md`. Si todos miran
  `dep`, 2 s apenas reduce a la mitad.

### 4. Comparar transportes (sección 2, RT-5)

Nuestra elección de SSE para el público es una **hipótesis**. Añade una ruta WebSocket pública solo para
el experimento, detrás de una variable de entorno. Con la misma carga, compara los tres transportes en
memoria por conexión, CPU, latencia de entrega, bytes por actualización y costo de reconexión.

**Listo cuando:** hay una tabla con datos propios y la elección se sostiene, o se cambió.

### 5. Cola de verificación y bloqueo (RF-7)

Crea `transport/ws/auditor-gateway.ts` siguiendo el modelo de `jurado-gateway.ts`, regístralo en el
`upgrade` de `main.ts`, y añade `public/auditor.html`. Decisiones de diseño ya tomadas:

- **Tomar un caso** (Lua, atómico): verifica que siga en la cola, lo pasa a un ZSET de arrendamientos con
  vencimiento, crea el bloqueo con dueño y un token de cercado obtenido con `INCR`, y emite el evento.
- **La tensión entre expirar y no expirar se resuelve con dos relojes separados:**
  - _Arrendamiento_ (~30 s, renovado cada ~10 s por latido): detecta navegador cerrado o red caída.
  - _Actividad_ (~5 min sin teclado ni ratón): detecta al que se fue a almorzar. El servidor deja de
    renovar si no hay actividad reciente, y la consola avisa antes de que ocurra.
- **Liberación segura:** el script compara el token antes de actuar. Un auditor con el bloqueo vencido
  recibe `LOCK_LOST`, y su resultado tardío se descarta. Esto vale también al resolver, no solo al liberar.
- **El caso vuelve a la cola con un barrido**, no con notificaciones de expiración de Redis, que se
  pierden si nadie escucha. Cada instancia lo intenta con la misma guarda que `flush_window`.
- **Eventos en un Stream más Pub/Sub**, con el mismo patrón de cursor de RF-6: las consolas también se caen.

Cuidado con dos cosas de `submit_acta.lua`:

- hoy puede volver a encolar un caso que un auditor tiene tomado;
- si llega una versión nueva mientras se revisa una vieja, la resolución del auditor debe fallar: decide
  y prueba ese caso.

Resolver un caso aplica una versión nueva por el mismo `submit_acta`, para conservar la convergencia.

**Listo cuando:** una prueba lanza 120 intentos simultáneos sobre un caso y gana exactamente uno, y otra
demuestra que un dueño vencido no puede liberar el bloqueo del nuevo dueño.

### 6. Presencia (RF-8)

ZSET con el último latido como puntaje, y un hash con caso actual y hora de inicio. Latido cada ~10 s,
vigencia de ~30 s. Los fantasmas se filtran al leer y se limpian con `ZREMRANGEBYSCORE`. Añade la vista
del coordinador.

**Listo cuando:** al matar un navegador con `kill -9`, el auditor desaparece solo de la lista en menos de
30 s, y su caso vuelve a la cola.

### 7. Demostraciones de falla

- **RF-9:** un cliente que lee muy despacio. Muestra `slowClients` y la memoria sin dispararse.
- **RF-10:** script en `load/` que mata una instancia con miles de clientes y dibuja reconexiones por
  segundo **con jitter y sin jitter**. Mide también la carga sobre las 7 restantes.
- **RF-6:** memoria del historial con `MEMORY USAGE` en el pico; es un dato que pide el enunciado.

### 8. Tablero e INP (RT-7, RT-9)

- `public/ops.html` sobre `/api/ops/metrics`: conexiones por instancia, mensajes por segundo, retraso del
  Event Loop, memoria por conexión, actas por minuto y retraso de publicación. Debe poder verse en vivo.
- INP con `PerformanceObserver` o `web-vitals`, en Chrome con CPU 6× más lenta y red 3G, bajo carga, sobre
  la página pública. Mejora también su diseño: es un esqueleto funcional.

### 9. Informe

Justifica cada estructura de Redis (sección 5) y cada «debe explicar» del enunciado. `ARCHITECTURE.md` ya
tiene la mayoría: reemplaza cada **hipótesis** y cada **pendiente** por datos.

## Deuda conocida

Arréglala cuando toques esa zona:

- **Seguridad, lo más grave:** cualquier token de jurado puede transmitir cualquier mesa. Ata el jurado a
  su mesa.
- La app del jurado no sube la foto: solo manda `hash_foto`. Va por HTTP, no por el WebSocket, que tiene
  tope de 16 KiB.
- El jurado no recibe aún «corrección o rechazo» posterior del servidor. Necesita canal por jurado y
  bandeja durable, porque suele estar desconectado.
- `/api/ops/metrics` y el login no tienen autenticación ni límite de tasa, y `/api/public/stream` no tiene
  límite por IP.
- Redis y nginx son puntos únicos de falla. Si se queda así, explícalo en el informe.
- `bytesPerConnection` es una aproximación por RSS: para el informe, mide con conexiones de a miles.

## Preguntas para el profesor

Pregunta esto pronto, porque afecta lo que se entrega:

1. El enunciado remite dos veces a una **«sección 7»** que fija qué medir, pero el PDF termina en la
   sección 6. ¿Falta una página?
2. RF-6 habla de «acumulado **nacional**», pero el caso es departamental. Asumimos departamental.
3. El ejemplo de acta tiene `mesa: 4201` pero su identificador dice mesa `0042`. Asumimos número global
   contra número local del puesto, y no validamos que coincidan.
4. No se indica el número de municipios. Asumimos 115, repartidos para que el ejemplo sea válido tal cual.
