import { TokenService } from './application/auth.js';
import { SnapshotService } from './application/snapshot-service.js';
import { WindowFlusher } from './application/window-flusher.js';
import { loadConfig } from './config.js';
import { InstanceMetrics } from './infrastructure/metrics/instance-metrics.js';
import { MetricsStore } from './infrastructure/metrics/metrics-store.js';
import { RedisBackplane } from './infrastructure/redis/backplane.js';
import { createCommandClient, createSubscriberClient } from './infrastructure/redis/client.js';
import { RateLimiter } from './infrastructure/redis/rate-limiter.js';
import { RedisHealth } from './infrastructure/redis/redis-health.js';
import { ResultsRepository } from './infrastructure/redis/results-repository.js';
import { registerScripts } from './infrastructure/redis/scripts.js';
import { isSeeded } from './infrastructure/redis/seed.js';
import { buildHttpServer } from './transport/http/server.js';
import { PublicStreamService } from './transport/sse/public-stream-service.js';
import { JuradoGateway } from './transport/ws/jurado-gateway.js';

const SHUTDOWN_GRACE_MS = 5_000;

/** Raíz de composición: el único lugar que conoce todas las implementaciones concretas. */
async function main(): Promise<void> {
  const config = loadConfig();
  const { INSTANCE_ID: instanceId } = config;

  const redis = registerScripts(createCommandClient(config.REDIS_URL));
  const subscriber = createSubscriberClient(config.REDIS_URL);
  const health = new RedisHealth(redis);

  const results = new ResultsRepository(redis, {
    idemTtlSeconds: config.IDEM_TTL_SECONDS,
    historyMaxEntries: config.HISTORY_MAX_ENTRIES,
  });
  const snapshots = new SnapshotService(results);
  const tokens = new TokenService(config.AUTH_SECRET, config.TOKEN_TTL_SECONDS);
  const instanceMetrics = new InstanceMetrics(instanceId);

  const publicStream = new PublicStreamService(results, snapshots, instanceMetrics, {
    batchSize: config.FANOUT_BATCH_SIZE,
    maxReplayEntries: config.MAX_REPLAY_ENTRIES,
    limits: { softBytes: config.SLOW_CLIENT_SOFT_BYTES, hardBytes: config.SLOW_CLIENT_HARD_BYTES },
  });

  let draining = false;
  const metricsStore = new MetricsStore(
    redis,
    instanceMetrics,
    {
      publicConnections: () => publicStream.connectionCount,
      juradoConnections: () => juradoGateway.connectionCount,
      fanoutPendingJobs: () => publicStream.pendingFanoutJobs,
    },
    { instanceId, intervalMs: config.METRICS_INTERVAL_MS },
    (error) => http.log.debug({ error }, 'Métricas no reportadas'),
  );

  const http = buildHttpServer({
    instanceId,
    logLevel: config.LOG_LEVEL,
    maxPublicConnections: config.MAX_PUBLIC_CONNECTIONS,
    accessCodes: { jurado: config.ACCESS_CODE_JURADO, auditor: config.ACCESS_CODE_AUDITOR },
    tokens,
    publicStream,
    snapshots,
    health,
    metrics: metricsStore,
    isDraining: () => draining,
  });
  const logRedisError = (error: unknown) => http.log.warn({ error }, 'Operación de Redis fallida');

  const juradoGateway = new JuradoGateway(
    results,
    new RateLimiter(redis),
    tokens,
    { submitsPerMinute: config.RATE_LIMIT_SUBMITS_PER_MINUTE, instanceId },
    logRedisError,
  );

  publicStream.attachBackplane(
    new RedisBackplane(
      subscriber,
      results,
      {
        onDelta: (delta) => publicStream.onDelta(delta),
        onResyncRequired: (topic) => publicStream.onResyncRequired(topic),
      },
      logRedisError,
    ),
  );

  // El cliente de ioredis emite 'error' en cada fallo de conexión: sin manejador, el proceso muere.
  redis.on('error', logRedisError);
  subscriber.on('error', logRedisError);
  health.onChange((available) => {
    http.log.warn({ available }, 'Cambio de estado de Redis');
    publicStream.publishStatus({ redis: available ? 'up' : 'down' });
  });

  await waitUntilReady(redis);
  if (!(await isSeeded(redis))) {
    throw new Error('Catálogo sin sembrar: ejecute el comando seed antes de iniciar');
  }

  http.server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://internal');
    if (pathname === '/ws/jurado') juradoGateway.handleUpgrade(request, socket, head);
    else socket.destroy();
  });

  const flusher = new WindowFlusher(
    results,
    { windowMs: config.FLUSH_WINDOW_MS, instanceId },
    logRedisError,
  );

  await http.listen({ host: '0.0.0.0', port: config.PORT });
  publicStream.start();
  juradoGateway.start();
  flusher.start();
  metricsStore.start();

  const shutdown = async () => {
    if (draining) return;
    draining = true;
    http.log.info('Cerrando de forma ordenada');
    flusher.stop();
    metricsStore.stop();
    publicStream.drain();
    juradoGateway.drain();
    const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    forceExit.unref();
    await http.close();
    redis.disconnect();
    subscriber.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

function waitUntilReady(redis: { status: string; once: (e: 'ready', l: () => void) => void }) {
  return new Promise<void>((resolve) => {
    if (redis.status === 'ready') resolve();
    else redis.once('ready', resolve);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
