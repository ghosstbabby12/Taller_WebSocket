/**
 * Verificación de punta a punta contra el stack desplegado:
 *   npm run smoke                  (BASE_URL=http://localhost:8080 por defecto)
 *   npm run smoke -- --chaos       además cae Redis y mata una instancia (requiere Docker local)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { JuradoTestClient } from '../load/jurado-client.js';
import { PublicClient } from '../load/sse-client.js';
import { buildCatalog } from '../src/domain/catalog.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.LB_PORT ?? 8080}`;
const ACCESS_CODE = process.env.ACCESS_CODE_JURADO;
const TOPIC = 'dep';
const CLIENTS = 16;

const catalog = buildCatalog();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString();

async function step(name: string, run: () => Promise<void>) {
  const startedAt = Date.now();
  await run();
  console.log(`  ok  ${name} (${Date.now() - startedAt} ms)`);
}

/** Acta cuadrada en una mesa al azar. La versión basada en el reloj permite repetir el smoke. */
function newActa(jurado: string) {
  const { mesa, puesto, municipio } = catalog[Math.floor(Math.random() * catalog.length)]!;
  const base = {
    acta: `E14-${puesto}-${String(mesa).padStart(4, '0')}-03`,
    mesa,
    puesto,
    municipio,
    jurado,
    ts_cierre: 1793577600,
    hash_foto: 'smoke',
  };
  const baseVersion = Math.floor(Date.now() / 1000);
  return (versionOffset: number, c1: number) => ({
    ...base,
    version: baseVersion + versionOffset,
    votos: { C1: c1, C2: 100 - c1, BLANCO: 0, NULO: 0, NO_MARCADO: 0 },
    sufragantes: 100,
    idem: randomUUID().replaceAll('-', '').slice(0, 16),
  });
}

async function login(subject: string): Promise<string> {
  assert.ok(ACCESS_CODE, 'Falta ACCESS_CODE_JURADO (.env)');
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'jurado', subject, accessCode: ACCESS_CODE }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

const readPublished = async () => {
  const response = await fetch(`${BASE_URL}/api/public/snapshot?topics=${TOPIC}`);
  return ((await response.json()) as { snapshots: { seq: number; state: object }[] }).snapshots[0]!;
};

async function main() {
  const chaos = process.argv.includes('--chaos');
  const subject = `JUR-${Math.floor(Math.random() * 1e6)}`;
  const token = await login(subject);
  const jurado = new JuradoTestClient(BASE_URL, token);
  await jurado.connect();

  const clients = Array.from({ length: CLIENTS }, () => new PublicClient(BASE_URL, [TOPIC]));

  await step('RT-1/RT-2: las conexiones caen en 8 instancias distintas, sin afinidad', async () => {
    await Promise.all(clients.map((client) => client.connect()));
    const instances = new Set(clients.map((client) => client.instance));
    console.log(`      ${CLIENTS} conexiones en ${instances.size} instancias`);
    assert.equal(instances.size, 8);
  });

  await step('RF-6: un cliente nuevo recibe la fotografía', async () => {
    await Promise.all(clients.map((c) => c.until(() => c.state.cursor(TOPIC) !== undefined)));
  });

  const version = newActa(subject);
  const v1 = version(0, 60);
  let seqBeforeFirstActa = 0;

  await step('RF-1: el acta se registra y el reenvío recibe respuesta inequívoca', async () => {
    seqBeforeFirstActa = await freshSeq();
    assert.equal((await jurado.submit(v1)).status, 'registered');
    for (let i = 0; i < 4; i++) assert.equal((await jurado.submit(v1)).status, 'duplicate');
  });

  await step('RF-4/RT-3: el cambio llega a clientes de todas las instancias', async () => {
    await untilAllReach(clients, await waitForNewSeq(seqBeforeFirstActa));
    assertAllEqual(clients);
  });

  const absent = clients[0]!;
  await step('RF-2 + RF-6: quien se ausenta vuelve igual, aunque haya correcciones', async () => {
    const seqBefore = absent.state.cursor(TOPIC)!;
    absent.disconnect();
    assert.equal((await jurado.submit(version(2, 40))).status, 'registered');
    assert.equal((await jurado.submit(version(1, 50))).status, 'superseded'); // Fuera de orden.
    const seq = await waitForNewSeq(seqBefore);
    await untilAllReach(clients.slice(1), seq);

    const snapshotsBefore = absent.eventCounts.snapshot;
    await absent.connect();
    await absent.until(() => (absent.state.cursor(TOPIC) ?? 0) >= seq, 5_000, 'recuperación');
    assert.equal(absent.eventCounts.snapshot, snapshotsBefore, 'Debió recuperar con detalle');
    assertAllEqual(clients);
  });

  await step('RF-3: el público ve la explicación de la corrección', async () => {
    const corrections = clients[1]!.state.view(TOPIC)?.corrections ?? [];
    assert.equal(corrections[0]?.acta, v1.acta);
  });

  await step('RT-7: el tablero reporta las 8 instancias', async () => {
    await sleep(2_500);
    const report = (await (await fetch(`${BASE_URL}/api/ops/metrics`)).json()) as {
      instances: { instanceId: string; eventLoopDelayMs: { p99: number } }[];
      totals: Record<string, number>;
    };
    assert.equal(report.instances.length, 8);
    console.log('      totales:', JSON.stringify(report.totals));
  });

  if (chaos) await runChaos(clients, jurado, subject);

  for (const client of clients) client.disconnect();
  jurado.close();
  console.log('\nSmoke OK');
  process.exit(0);
}

async function runChaos(clients: PublicClient[], jurado: JuradoTestClient, subject: string) {
  await step(
    'RF-10: sin Redis, el jurado recibe un rechazo explícito y el público lo sabe',
    async () => {
      docker('compose', 'stop', 'redis');
      try {
        await Promise.all(clients.map((c) => c.until(() => c.redisStatus === 'down')));
        const reply = await jurado.submit(newActa(subject)(0, 55));
        assert.equal(reply.type, 'acta.nack');
        assert.equal(reply.code, 'BACKEND_UNAVAILABLE');
        assert.equal(reply.retryable, true);
      } finally {
        docker('compose', 'start', 'redis');
      }
    },
  );

  await step('RF-10: al volver Redis, todo se recupera sin intervención', async () => {
    await Promise.all(clients.map((c) => c.until(() => c.redisStatus === 'up', 20_000)));
    await sleep(500);
    const before = await freshSeq();
    const retry = newActa(subject)(0, 45);
    assert.equal((await jurado.submit(retry)).status, 'registered');
    await untilAllReach(clients, await waitForNewSeq(before));
    assertAllEqual(clients);
  });

  await step('Muerte de una instancia: sus clientes vuelven por otra y convergen', async () => {
    // Otra que la del jurado: su reconexión la cubre JuradoClient en el navegador, no este cliente.
    const victim = clients.find((c) => c.instance !== jurado.instance)!.instance;
    docker('kill', victim);
    const orphans = clients.filter((client) => client.instance === victim);
    assert.ok(orphans.length > 0);
    await sleep(200);
    for (const orphan of orphans) {
      orphan.disconnect();
      await orphan.connect();
      assert.notEqual(orphan.instance, victim);
    }
    const before = await freshSeq();
    assert.equal((await jurado.submit(newActa(subject)(0, 30))).type, 'acta.ack');
    await untilAllReach(clients, await waitForNewSeq(before));
    assertAllEqual(clients);
    docker('compose', 'up', '-d', '--no-recreate', '--scale', 'app=8', 'app');
  });
}

/** Secuencia publicada actual, ya sin la caché de fotografías de las instancias. */
async function freshSeq(): Promise<number> {
  await sleep(1_100);
  return (await readPublished()).seq;
}

/** Espera a que se publique una ventana posterior a `after` y devuelve su secuencia. */
async function waitForNewSeq(after: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { seq } = await readPublished();
    if (seq > after) return seq;
    if (Date.now() > deadline) throw new Error('No se publicó una nueva ventana');
    await sleep(200);
  }
}

const untilAllReach = (clients: PublicClient[], seq: number) =>
  Promise.all(clients.map((c) => c.until(() => (c.state.cursor(TOPIC) ?? 0) >= seq)));

/** Todos en la misma secuencia deben tener exactamente el mismo estado. */
function assertAllEqual(clients: PublicClient[]) {
  const views = clients.map((c) => c.state.view(TOPIC)!);
  const newest = Math.max(...views.map((view) => view.seq));
  const atNewest = views.filter((view) => view.seq === newest);
  for (const view of atNewest) assert.deepEqual(view.values, atNewest[0]!.values);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
