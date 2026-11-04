import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BatchedBroadcaster } from '../../src/fanout/batched-broadcaster.js';
import { TopicRegistry } from '../../src/fanout/topic-registry.js';
import { SseConnection } from '../../src/transport/sse/sse-connection.js';

const untilEmpty = async <T>(broadcaster: BatchedBroadcaster<T>) => {
  while (broadcaster.pendingJobs > 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe('TopicRegistry', () => {
  it('avisa del primer suscriptor y de los tópicos que quedan vacíos', () => {
    const registry = new TopicRegistry<object>();
    const [a, b] = [{}, {}];
    expect(registry.add(a, 'dep')).toBe(true);
    expect(registry.add(b, 'dep')).toBe(false);
    expect(registry.add(a, 'mun:1')).toBe(true);

    expect(registry.removeConnection(a)).toEqual(['mun:1']);
    expect(registry.removeConnection(b)).toEqual(['dep']);
    expect(registry.connectionCount).toBe(0);
    expect(registry.topicCount).toBe(0);
  });

  it('el recorrido de un tópico no toca a los demás', () => {
    const registry = new TopicRegistry<object>();
    for (let i = 0; i < 1_000; i++) registry.add({}, 'mun:1');
    const one = {};
    registry.add(one, 'puesto:7');
    expect([...registry.subscribers('puesto:7')]).toEqual([one]);
  });
});

describe('BatchedBroadcaster', () => {
  it('cede el Event Loop: un temporizador corre en medio de un envío grande', async () => {
    const broadcaster = new BatchedBroadcaster<number>(100);
    const targets = Array.from({ length: 5_000 }, (_, i) => i);
    const delivered: number[] = [];
    let deliveredWhenOtherWorkRan = -1;

    setImmediate(() => (deliveredWhenOtherWorkRan = delivered.length));
    broadcaster.broadcast(targets, (target) => delivered.push(target));
    await untilEmpty(broadcaster);
    await vi.waitFor(() => expect(delivered).toHaveLength(5_000));

    expect(deliveredWhenOtherWorkRan).toBeGreaterThan(0);
    expect(deliveredWhenOtherWorkRan).toBeLessThan(5_000);
  });

  it('respeta el orden entre envíos y las bajas durante el envío', async () => {
    const broadcaster = new BatchedBroadcaster<string>(1);
    const targets = new Set(['a', 'b', 'c']);
    const log: string[] = [];

    broadcaster.broadcast(targets, (t) => {
      log.push(`1${t}`);
      targets.delete('c');
    });
    broadcaster.broadcast(['a'], (t) => log.push(`2${t}`));
    await vi.waitFor(() => expect(log).toContain('2a'));

    expect(log).toEqual(['1a', '1b', '2a']);
  });
});

describe('SseConnection (RF-9)', () => {
  const limits = { softBytes: 100, hardBytes: 200 };
  const frame = (seq: number) => ({ topic: 'dep' as const, seq, payload: Buffer.from(`${seq}`) });

  function setup() {
    const response = Object.assign(new EventEmitter(), {
      writableLength: 0,
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const events = {
      onCaughtUp: vi.fn(),
      onDeltaWritten: vi.fn(),
      onSkipped: vi.fn(),
      onDisconnectedSlow: vi.fn(),
    };
    const connection = new SseConnection(response as never, limits, events);
    connection.finishSync(new Map());
    return { response, events, connection };
  }

  it('omite detalle sobre el umbral suave y pide fotografía al drenar', () => {
    const { response, events, connection } = setup();
    response.writableLength = 150;
    connection.deliverDelta(frame(1));
    connection.deliverDelta(frame(2));
    expect(response.write).not.toHaveBeenCalled();

    response.writableLength = 0;
    connection.deliverDelta(frame(3)); // Bajó el búfer, pero aún no drena: sigue omitiendo.
    expect(response.write).not.toHaveBeenCalled();

    response.emit('drain');
    expect(events.onCaughtUp).toHaveBeenCalledWith(connection, new Map([['dep', 3]]));
    connection.deliverDelta(frame(4));
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('desconecta sobre el umbral duro', () => {
    const { response, events, connection } = setup();
    response.writableLength = 200;
    connection.deliverDelta(frame(1));
    expect(response.destroy).toHaveBeenCalled();
    expect(events.onDisconnectedSlow).toHaveBeenCalled();
  });

  it('al sincronizar guarda deltas y descarta los ya cubiertos', () => {
    const { response, connection } = setup();
    connection.beginSync();
    connection.deliverDelta(frame(5));
    connection.deliverDelta(frame(6));
    expect(response.write).not.toHaveBeenCalled();

    connection.finishSync(new Map([['dep', 5]]));
    expect(response.write).toHaveBeenCalledTimes(1);
    expect(response.write).toHaveBeenCalledWith(frame(6).payload);
  });
});
