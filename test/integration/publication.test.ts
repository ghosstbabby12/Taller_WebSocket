import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createResultsState } from '../../public/js/results-state.js';
import { buildCatalog } from '../../src/domain/catalog.js';
import { planRecovery } from '../../src/domain/recovery.js';
import type { TopicDelta } from '../../src/domain/results.js';
import type { Topic } from '../../src/domain/topics.js';
import { RedisBackplane } from '../../src/infrastructure/redis/backplane.js';
import { keys } from '../../src/infrastructure/redis/keys.js';
import { ENUNCIADO_ACTA, actaWith, correctedActa } from '../fixtures.js';
import {
  createTestRedis,
  createTestRepository,
  flush,
  resetDatabase,
  waitForGuard,
} from './helpers.js';

const redis = createTestRedis();
const repository = createTestRepository(redis);
const catalog = buildCatalog();

/** Un acta válida y cuadrada para cualquier mesa del catálogo. */
function actaForMesa(index: number) {
  const { mesa, puesto, municipio } = catalog[index]!;
  return actaWith({
    acta: `E14-${puesto}-${String(mesa).padStart(4, '0')}-03`,
    mesa,
    puesto,
    municipio,
  });
}

const flushWindow = async () => {
  await waitForGuard();
  return flush(repository);
};

beforeEach(() => resetDatabase(redis));
afterAll(() => redis.quit());

describe('RF-3: atomicidad y lectura consistente', () => {
  it('no publica nada hasta que termina la ventana', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    const [dep] = await repository.readSnapshots(['dep']);
    expect(dep?.state['v:C1']).toBeUndefined();
  });

  it('todos los niveles de una ventana comparten secuencia', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    const snapshots = await repository.readSnapshots(['dep', 'mun:11', 'puesto:176']);
    expect(new Set(snapshots.map((s) => s.seq)).size).toBe(1);
    for (const snapshot of snapshots) expect(snapshot.state['v:C1']).toBe(184);
  });

  it('el municipio siempre iguala la suma de sus puestos, incluso con escrituras simultáneas', async () => {
    const municipio = catalog[0]!.municipio;
    const mesas = catalog.filter((m) => m.municipio === municipio).slice(0, 40);
    const topics: Topic[] = [
      `mun:${municipio}`,
      ...[...new Set(mesas.map((m) => m.puesto))].map((p): Topic => `puesto:${p}`),
    ];

    let writing = true;
    const writer = (async () => {
      for (const { mesa } of mesas) {
        await repository.submit(actaForMesa(mesa - 1));
        await flushWindow();
      }
      writing = false;
    })();

    let reads = 0;
    while (writing) {
      const [mun, ...puestos] = await repository.readSnapshots(topics);
      const sumOfPuestos = puestos.reduce((sum, p) => sum + (p.state['v:C1'] ?? 0), 0);
      // Los puestos sin mesas de esta prueba también podrían sumar: solo escribimos en estos.
      expect(mun?.state['v:C1'] ?? 0).toBe(sumOfPuestos);
      reads += 1;
    }
    await writer;
    expect(reads).toBeGreaterThan(5);
  });

  it('el ranking se obtiene sin recorrer los candidatos', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    const [dep] = await repository.readSnapshots(['dep']);
    expect(dep?.ranking.map((r) => r.candidate)).toEqual(['C3', 'C1', 'C2']);
    expect(dep?.ranking[0]?.votes).toBe(311);
  });
});

describe('RF-4: agregación por ventana', () => {
  it('muchas actas en una ventana producen un solo mensaje por tópico', async () => {
    const subscriber = redis.duplicate();
    const messages: TopicDelta[] = [];
    await subscriber.subscribe(keys.channel('dep'));
    subscriber.on('message', (_c, raw) => messages.push(JSON.parse(raw)));

    for (let i = 0; i < 50; i++) await repository.submit(actaForMesa(i));
    await flushWindow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await subscriber.quit();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.changes.mesas_informadas).toBe(50);
  });

  it('el delta solo lleva los campos que cambiaron', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    await repository.submit(correctedActa(2, 10)); // Solo cambian C1 y C2.
    await flushWindow();
    const [read] = await repository.readRecovery([{ topic: 'dep', cursor: 1 }], 10);
    expect(read?.entries[0]?.changes).toEqual({ 'v:C1': 174, 'v:C2': 107 });
  });

  it('una sola instancia publica cada ventana', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => repository.flushWindow(1_000, `i-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('una ventana sin cambios no publica ni consume secuencia', async () => {
    expect(await flushWindow()).toBeNull();
    expect(await redis.get(keys.sequence)).toBeNull();
  });
});

describe('explicación de los cambios', () => {
  it('una corrección viaja con el delta y queda en la fotografía', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    await repository.submit(correctedActa(2, 10));
    await flushWindow();

    const [read] = await repository.readRecovery([{ topic: 'mun:11', cursor: 1 }], 10);
    expect(read?.entries[0]?.corrections?.[0]).toMatchObject({
      acta: ENUNCIADO_ACTA.acta,
      fromVersion: 1,
      toVersion: 2,
      reason: 'correction',
    });
    const [snapshot] = await repository.readSnapshots(['mun:11']);
    expect(snapshot?.corrections[0]?.toVersion).toBe(2);
  });
});

describe('RF-6: reconexión', () => {
  /** Cliente mínimo: aplica lo que el servidor le entregaría al reconectar con su cursor. */
  async function reconnect(client: ReturnType<typeof createResultsState>, topic: Topic) {
    const cursor = client.cursor(topic);
    const [read] = await repository.readRecovery([{ topic, cursor }], 31);
    const plan = planRecovery({
      cursor,
      currentSeq: read!.currentSeq,
      entries: read!.entries,
      maxReplay: 30,
    });
    if (plan === 'replay') {
      for (const entry of read!.entries) client.applyDelta(entry);
    } else if (plan === 'snapshot') {
      const [snapshot] = await repository.readSnapshots([topic]);
      client.applySnapshot(snapshot!);
    }
    return plan;
  }

  it('quien se ausentó queda exactamente igual que quien nunca se fue', async () => {
    const stayed = createResultsState();
    const left = createResultsState();
    const [initial] = await repository.readSnapshots(['dep']);
    stayed.applySnapshot(initial!);
    left.applySnapshot(initial!);

    let lastSeq = initial!.seq;
    for (let i = 0; i < 10; i++) {
      await repository.submit(actaForMesa(i));
      await flushWindow();
      const [read] = await repository.readRecovery([{ topic: 'dep', cursor: lastSeq }], 10);
      for (const entry of read!.entries) {
        stayed.applyDelta(entry);
        lastSeq = entry.seq;
      }
      if (i === 2) await reconnect(left, 'dep'); // Alcanzó a recibir hasta aquí, y se fue.
    }

    expect(await reconnect(left, 'dep')).toBe('replay');
    expect(left.view('dep')?.values).toEqual(stayed.view('dep')?.values);
    expect(left.cursor('dep')).toBe(stayed.cursor('dep'));
  });

  it('si el historial se recortó, entrega fotografía y el estado también coincide', async () => {
    const shortHistory = createTestRepository(redis, 2);
    const left = createResultsState();
    const [initial] = await shortHistory.readSnapshots(['dep']);
    left.applySnapshot(initial!);

    for (let i = 0; i < 6; i++) {
      await shortHistory.submit(actaForMesa(i));
      await waitForGuard();
      await flush(shortHistory);
    }
    expect(await redis.xlen(keys.history('dep'))).toBe(2);
    expect(await reconnect(left, 'dep')).toBe('snapshot');

    const [current] = await repository.readSnapshots(['dep']);
    expect(left.view('dep')?.values).toEqual(current?.state);
  });

  it('aplicar una entrada repetida o posterior a la fotografía no cuenta doble', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    const [snapshot] = await repository.readSnapshots(['dep']);
    const [read] = await repository.readRecovery([{ topic: 'dep', cursor: 0 }], 10);
    const client = createResultsState();
    client.applySnapshot(snapshot!);
    expect(client.applyDelta(read!.entries[0]!)).toBe('ignored');
    expect(client.view('dep')?.values['v:C1']).toBe(184);
  });
});

describe('backplane', () => {
  function startBackplane() {
    const subscriber = redis.duplicate();
    const deltas: TopicDelta[] = [];
    const resyncs: Topic[] = [];
    const backplane = new RedisBackplane(
      subscriber,
      repository,
      { onDelta: (d) => deltas.push(d), onResyncRequired: (t) => resyncs.push(t) },
      (error) => {
        throw error;
      },
    );
    return { subscriber, backplane, deltas, resyncs };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('entrega a una instancia lo publicado por otra', async () => {
    const { subscriber, backplane, deltas } = startBackplane();
    await backplane.subscribe('dep');
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    await settle();
    await subscriber.quit();
    expect(deltas.map((d) => d.topic)).toEqual(['dep']);
  });

  it('no pierde lo publicado mientras estuvo desconectada de Redis', async () => {
    const { subscriber, backplane, deltas } = startBackplane();
    await backplane.subscribe('dep');
    await repository.submit(ENUNCIADO_ACTA);
    await flushWindow();
    await settle();

    // Corte real: lo publicado ahora nunca llega por Pub/Sub, solo queda en el Stream.
    subscriber.disconnect(true);
    await repository.submit(correctedActa(2, 10));
    await flushWindow();
    await repository.submit(correctedActa(3, 20));
    await flushWindow();

    await new Promise((resolve) => setTimeout(resolve, 400));
    await subscriber.quit();
    expect(deltas.map((d) => d.seq)).toEqual([1, 2, 3]);
  });
});
