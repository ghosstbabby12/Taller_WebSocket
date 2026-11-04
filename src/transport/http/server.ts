import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { constantTimeEquals, type Role, type TokenService } from '../../application/auth.js';
import type { SnapshotService } from '../../application/snapshot-service.js';
import { MAX_TOPICS_PER_CONNECTION, isTopic, type Topic } from '../../domain/topics.js';
import type { MetricsStore } from '../../infrastructure/metrics/metrics-store.js';
import type { RedisHealth } from '../../infrastructure/redis/redis-health.js';
import type { PublicStreamService, TopicRequest } from '../sse/public-stream-service.js';
import { encodeSseEvent } from '../sse/sse-format.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../public');
const MAX_RETRY_AFTER_SECONDS = 30;

const loginSchema = z.object({
  role: z.enum(['jurado', 'auditor']),
  subject: z.string().regex(/^[A-Z]{3}-\d+$/),
  accessCode: z.string(),
});

export interface HttpDependencies {
  instanceId: string;
  logLevel: string;
  maxPublicConnections: number;
  accessCodes: Record<Role, string>;
  tokens: TokenService;
  publicStream: PublicStreamService;
  snapshots: SnapshotService;
  health: RedisHealth;
  metrics: MetricsStore;
  isDraining: () => boolean;
}

/** `?topics=dep,mun:11&cursors=120,98`. Un cursor vacío significa cliente nuevo en ese tópico. */
export function parseTopicRequests(query: {
  topics?: string;
  cursors?: string;
}): TopicRequest[] | null {
  const topics = (query.topics ?? '').split(',').filter(Boolean);
  if (topics.length === 0 || topics.length > MAX_TOPICS_PER_CONNECTION) return null;
  if (!topics.every(isTopic) || new Set(topics).size !== topics.length) return null;

  const cursors = (query.cursors ?? '').split(',');
  return (topics as Topic[]).map((topic, index) => {
    const cursor = Number.parseInt(cursors[index] ?? '', 10);
    return { topic, cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined };
  });
}

export function buildHttpServer(deps: HttpDependencies): FastifyInstance {
  const app = Fastify({ logger: { level: deps.logLevel } });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Instance-Id', deps.instanceId); // RT-1: verificable desde cualquier cliente.
  });

  app.register(fastifyStatic, { root: PUBLIC_DIR });

  app.get('/healthz', async () => ({ status: 'ok', instance: deps.instanceId }));

  // Sin Redis la instancia sigue lista: debe mantener a sus clientes e informarles la degradación.
  app.get('/readyz', async (_request, reply) => {
    if (deps.isDraining()) return reply.code(503).send({ status: 'draining' });
    return { status: 'ready', redis: deps.health.isAvailable ? 'up' : 'down' };
  });

  app.get('/api/instance', async () => ({
    instance: deps.instanceId,
    redis: deps.health.isAvailable ? 'up' : 'down',
  }));

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const { role, subject, accessCode } = parsed.data;
    if (!constantTimeEquals(accessCode, deps.accessCodes[role])) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    return { token: deps.tokens.issue(role, subject) };
  });

  // Polling: fallback y línea base de la comparación de transportes (sección 2 del enunciado).
  app.get<{ Querystring: { topics?: string } }>('/api/public/snapshot', async (request, reply) => {
    const requests = parseTopicRequests(request.query);
    if (!requests) return reply.code(400).send({ error: 'INVALID_TOPICS' });
    try {
      const snapshots = await deps.snapshots.read(requests.map(({ topic }) => topic));
      const etag = `"${snapshots.map(({ seq }) => seq).join('-')}"`;
      reply.header('ETag', etag).header('Cache-Control', 'no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return { snapshots };
    } catch {
      return reply.code(503).header('Retry-After', jitteredRetryAfter()).send({
        error: 'BACKEND_UNAVAILABLE',
      });
    }
  });

  app.get<{ Querystring: { topics?: string; cursors?: string } }>(
    '/api/public/stream',
    (request, reply) => {
      const requests = parseTopicRequests(request.query);
      if (!requests) {
        void reply.code(400).send({ error: 'INVALID_TOPICS' });
        return;
      }
      // Control de admisión: rechazar barato protege a los clientes ya conectados (RF-10).
      if (deps.isDraining() || deps.publicStream.connectionCount >= deps.maxPublicConnections) {
        void reply.code(503).header('Retry-After', jitteredRetryAfter()).send({
          error: 'INSTANCE_FULL',
        });
        return;
      }

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Instance-Id': deps.instanceId,
      });
      response.write(
        encodeSseEvent('hello', {
          instance: deps.instanceId,
          redis: deps.health.isAvailable ? 'up' : 'down',
        }),
      );

      const connection = deps.publicStream.createConnection(response);
      response.on('close', () => deps.publicStream.close(connection));
      response.on('error', () => response.destroy()); // Escritura tras el cierre del cliente.
      deps.publicStream.open(connection, requests).catch((error: unknown) => {
        request.log.warn({ error }, 'No se pudo sincronizar la conexión pública');
        connection.close(encodeSseEvent('status', { redis: 'down' }));
      });
    },
  );

  app.get('/api/ops/metrics', async (_request, reply) => {
    try {
      return await deps.metrics.read();
    } catch {
      return reply.code(503).send({ error: 'BACKEND_UNAVAILABLE' });
    }
  });

  return app;
}

/** Evita que todos los rechazados vuelvan en el mismo segundo. */
const jitteredRetryAfter = () => String(1 + Math.floor(Math.random() * MAX_RETRY_AFTER_SECONDS));
