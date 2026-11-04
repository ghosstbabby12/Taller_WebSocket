import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface InstanceSample {
  instanceId: string;
  at: number;
  connections: { public: number; jurado: number };
  messagesPerSecond: number;
  fanoutPendingJobs: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  memory: { rssBytes: number; heapUsedBytes: number; bytesPerConnection: number | null };
  slowClients: { skippedDeltas: number; disconnected: number };
}

export interface ConnectionGauges {
  publicConnections: () => number;
  juradoConnections: () => number;
  fanoutPendingJobs: () => number;
}

const NS_PER_MS = 1e6;
const toMs = (ns: number) => Math.round((ns / NS_PER_MS) * 100) / 100;

/** Contadores de una instancia. Se resetean en cada muestra, salvo los acumulados. */
export class InstanceMetrics {
  private readonly eventLoop: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  private emittedSinceLastSample = 0;
  private skippedDeltas = 0;
  private slowDisconnects = 0;
  private lastSampleAt = Date.now();
  private baselineRss = process.memoryUsage().rss;

  constructor(private readonly instanceId: string) {
    this.eventLoop.enable();
  }

  countEmitted(messages: number): void {
    this.emittedSinceLastSample += messages;
  }

  countSkippedDelta(): void {
    this.skippedDeltas += 1;
  }

  countSlowDisconnect(): void {
    this.slowDisconnects += 1;
  }

  /** Toma una muestra y devuelve además los mensajes emitidos desde la anterior. */
  sample(gauges: ConnectionGauges): { sample: InstanceSample; emitted: number } {
    const now = Date.now();
    const elapsedSeconds = Math.max((now - this.lastSampleAt) / 1000, 0.001);
    const emitted = this.emittedSinceLastSample;
    const memory = process.memoryUsage();
    const publicConnections = gauges.publicConnections();

    const sample: InstanceSample = {
      instanceId: this.instanceId,
      at: now,
      connections: { public: publicConnections, jurado: gauges.juradoConnections() },
      messagesPerSecond: Math.round(emitted / elapsedSeconds),
      fanoutPendingJobs: gauges.fanoutPendingJobs(),
      eventLoopDelayMs: {
        p50: toMs(this.eventLoop.percentile(50)),
        p99: toMs(this.eventLoop.percentile(99)),
        max: toMs(this.eventLoop.max),
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        bytesPerConnection:
          publicConnections > 0
            ? Math.round(Math.max(memory.rss - this.baselineRss, 0) / publicConnections)
            : null,
      },
      slowClients: { skippedDeltas: this.skippedDeltas, disconnected: this.slowDisconnects },
    };

    this.eventLoop.reset();
    this.emittedSinceLastSample = 0;
    this.lastSampleAt = now;
    return { sample, emitted };
  }
}
