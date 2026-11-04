import type { SnapshotService } from '../../application/snapshot-service.js';
import type { BackpressureLimits } from '../../domain/backpressure.js';
import { planRecovery } from '../../domain/recovery.js';
import type { TopicDelta } from '../../domain/results.js';
import type { Topic } from '../../domain/topics.js';
import { BatchedBroadcaster } from '../../fanout/batched-broadcaster.js';
import { TopicRegistry } from '../../fanout/topic-registry.js';
import type { RedisBackplane } from '../../infrastructure/redis/backplane.js';
import type { ResultsRepository } from '../../infrastructure/redis/results-repository.js';
import type { InstanceMetrics } from '../../infrastructure/metrics/instance-metrics.js';
import { SseConnection, type DeltaFrame } from './sse-connection.js';
import { SSE_HEARTBEAT, encodeSseEvent } from './sse-format.js';

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface TopicRequest {
  topic: Topic;
  cursor: number | undefined;
}

/** Audiencia pública: suscripción, recuperación, fan-out y contrapresión (RF-4, 5, 6, 9). */
export class PublicStreamService {
  private readonly registry = new TopicRegistry<SseConnection, Topic>();
  private readonly broadcaster: BatchedBroadcaster<SseConnection>;
  private heartbeatTimer?: NodeJS.Timeout;
  private backplane!: RedisBackplane;

  constructor(
    private readonly repository: ResultsRepository,
    private readonly snapshots: SnapshotService,
    private readonly metrics: InstanceMetrics,
    private readonly options: {
      batchSize: number;
      maxReplayEntries: number;
      limits: BackpressureLimits;
    },
  ) {
    this.broadcaster = new BatchedBroadcaster(options.batchSize);
  }

  /** Se conecta aparte porque el backplane necesita a su vez los manejadores de este servicio. */
  attachBackplane(backplane: RedisBackplane): void {
    this.backplane = backplane;
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => {
      this.broadcastToAll((connection) => connection.writeRaw(SSE_HEARTBEAT));
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  get connectionCount() {
    return this.registry.connectionCount;
  }

  get pendingFanoutJobs() {
    return this.broadcaster.pendingJobs;
  }

  createConnection(response: ConstructorParameters<typeof SseConnection>[0]): SseConnection {
    return new SseConnection(response, this.options.limits, {
      onCaughtUp: (connection, minSeq) => void this.resync(connection, minSeq),
      onDeltaWritten: () => this.metrics.countEmitted(1),
      onSkipped: () => this.metrics.countSkippedDelta(),
      onDisconnectedSlow: () => this.metrics.countSlowDisconnect(),
    });
  }

  /**
   * Orden crítico, y cada paso depende del anterior:
   * 1. registrar la conexión: desde aquí los deltas vivos se guardan en la conexión;
   * 2. esperar la suscripción en el backplane;
   * 3. leer la recuperación: todo lo publicado después ya llega por el paso 1;
   * 4. volcar lo guardado descartando lo que la recuperación ya cubrió.
   * Sin este orden, un acta publicada entre el paso 3 y el 1 se perdería.
   */
  async open(connection: SseConnection, requests: readonly TopicRequest[]): Promise<void> {
    const topics = requests.map(({ topic }) => topic);
    for (const topic of topics) this.registry.add(connection, topic);
    await Promise.all(topics.map((topic) => this.backplane.subscribe(topic)));

    const reads = await this.repository.readRecovery(requests, this.options.maxReplayEntries + 1);
    const syncedSeq = new Map<Topic, number>();
    const needSnapshot = new Map<Topic, number>();

    for (const read of reads) {
      const cursor = requests.find(({ topic }) => topic === read.topic)?.cursor;
      const plan = planRecovery({
        cursor,
        currentSeq: read.currentSeq,
        entries: read.entries,
        maxReplay: this.options.maxReplayEntries,
      });
      if (plan === 'snapshot') {
        needSnapshot.set(read.topic, read.currentSeq);
      } else if (plan === 'replay') {
        for (const entry of read.entries) connection.writeRaw(encodeSseEvent('delta', entry));
        this.metrics.countEmitted(read.entries.length);
        syncedSeq.set(read.topic, read.currentSeq);
      } else {
        syncedSeq.set(read.topic, read.currentSeq);
      }
    }

    await this.writeSnapshots(connection, needSnapshot, syncedSeq);
    connection.finishSync(syncedSeq);
  }

  close(connection: SseConnection): void {
    for (const topic of this.registry.removeConnection(connection)) {
      void this.backplane.unsubscribe(topic).catch(() => {
        // Sin Redis no hay canal que soltar; ioredis no lo restaurará porque ya no está en el mapa.
      });
    }
  }

  publishStatus(payload: { redis: 'up' | 'down' }): void {
    const frame = encodeSseEvent('status', payload);
    this.broadcastToAll((connection) => connection.writeRaw(frame));
  }

  /** Cierre ordenado: el cliente reconecta contra otra instancia con su cursor y su backoff. */
  drain(): void {
    const frame = encodeSseEvent('goaway', {});
    for (const connection of this.registry.connections()) connection.close(frame);
  }

  onDelta(delta: TopicDelta): void {
    const frame: DeltaFrame = {
      topic: delta.topic,
      seq: delta.seq,
      payload: encodeSseEvent('delta', delta),
    };
    this.broadcaster.broadcast(this.registry.subscribers(delta.topic), (connection) => {
      connection.deliverDelta(frame);
    });
  }

  onResyncRequired(topic: Topic): void {
    this.broadcaster.broadcast(this.registry.subscribers(topic), (connection) => {
      void this.resync(connection, new Map([[topic, 0]]));
    });
  }

  private broadcastToAll(deliver: (connection: SseConnection) => void): void {
    this.broadcaster.broadcast(this.registry.connections(), deliver);
  }

  private async resync(
    connection: SseConnection,
    minSeq: ReadonlyMap<Topic, number>,
  ): Promise<void> {
    connection.beginSync();
    const syncedSeq = new Map<Topic, number>();
    try {
      await this.writeSnapshots(connection, minSeq, syncedSeq);
      connection.finishSync(syncedSeq);
    } catch {
      // Sin la fotografía el cliente tendría un hueco: se corta y vuelve con su cursor.
      connection.close();
    }
  }

  private async writeSnapshots(
    connection: SseConnection,
    minSeq: ReadonlyMap<Topic, number>,
    syncedSeq: Map<Topic, number>,
  ): Promise<void> {
    if (minSeq.size === 0) return;
    for (const snapshot of await this.snapshots.readAtLeast(minSeq)) {
      connection.writeRaw(encodeSseEvent('snapshot', snapshot));
      this.metrics.countEmitted(1);
      syncedSeq.set(snapshot.topic, snapshot.seq);
    }
  }
}
