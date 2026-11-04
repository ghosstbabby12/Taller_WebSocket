import type { Redis } from 'ioredis';
import { keys } from '../redis/keys.js';
import type { ConnectionGauges, InstanceMetrics, InstanceSample } from './instance-metrics.js';

const SAMPLE_TTL_MS = 10_000;
/** Cifra ingenua del enunciado: 6.400 actas por 400.000 clientes. */
const NAIVE_MESSAGES_SPEC = 6_400 * 400_000;

export interface OperationsReport {
  instances: InstanceSample[];
  totals: {
    publicConnections: number;
    messagesEmitted: number;
    actasRegistered: number;
    /** Lo que habría emitido una difusión por acta con las conexiones actuales. */
    naiveMessagesAtCurrentAudience: number;
    naiveMessagesSpec: number;
  };
  actasPerMinute: { minute: number; actas: number }[];
  publishLagMs: number;
}

/** Comparte métricas a través de Redis: las instancias no se hablan entre sí (RT-3). */
export class MetricsStore {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly metrics: InstanceMetrics,
    private readonly gauges: ConnectionGauges,
    private readonly options: { instanceId: string; intervalMs: number },
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.report().catch(this.onError), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async report(): Promise<void> {
    const { sample, emitted } = this.metrics.sample(this.gauges);
    const { instanceId } = this.options;
    const pipeline = this.redis
      .multi()
      .set(keys.metricsInstance(instanceId), JSON.stringify(sample), 'PX', SAMPLE_TTL_MS)
      .zadd(keys.metricsInstances, sample.at, instanceId)
      .zremrangebyscore(keys.metricsInstances, 0, sample.at - SAMPLE_TTL_MS);
    if (emitted > 0) pipeline.incrby(keys.messagesTotal, emitted);
    await pipeline.exec();
  }

  async read(): Promise<OperationsReport> {
    const instanceIds = await this.redis.zrangebyscore(
      keys.metricsInstances,
      Date.now() - SAMPLE_TTL_MS,
      '+inf',
    );
    const samples = instanceIds.length
      ? await this.redis.mget(instanceIds.map(keys.metricsInstance))
      : [];
    const instances = samples.flatMap((raw) => (raw ? [JSON.parse(raw) as InstanceSample] : []));

    const [messagesTotal, perMinute, lag] = await Promise.all([
      this.redis.get(keys.messagesTotal),
      this.redis.hgetall(keys.actasPerMinute),
      this.redis.get(keys.publishLagMs),
    ]);
    const actasPerMinute = Object.entries(perMinute)
      .map(([minute, actas]) => ({ minute: Number(minute), actas: Number(actas) }))
      .sort((a, b) => a.minute - b.minute);
    const actasRegistered = actasPerMinute.reduce((sum, { actas }) => sum + actas, 0);
    const publicConnections = instances.reduce((sum, i) => sum + i.connections.public, 0);

    return {
      instances,
      totals: {
        publicConnections,
        messagesEmitted: Number(messagesTotal ?? 0),
        actasRegistered,
        naiveMessagesAtCurrentAudience: actasRegistered * publicConnections,
        naiveMessagesSpec: NAIVE_MESSAGES_SPEC,
      },
      actasPerMinute,
      publishLagMs: Number(lag ?? 0),
    };
  }
}
