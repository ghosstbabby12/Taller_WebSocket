import { hostname } from 'node:os';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  PORT: positiveInt(3000),
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.string().default('info'),
  REDIS_URL: z.string().url(),
  /** Firma tokens sin estado: cualquier instancia valida a cualquier cliente (RT-2). */
  AUTH_SECRET: z.string().min(32),
  ACCESS_CODE_JURADO: z.string().min(8),
  ACCESS_CODE_AUDITOR: z.string().min(8),

  /** Ventana de agregación del fan-out público (RF-4). */
  FLUSH_WINDOW_MS: positiveInt(2_000),
  /** Conexiones atendidas antes de ceder el control al Event Loop (RF-4). */
  FANOUT_BATCH_SIZE: positiveInt(500),
  /** Entradas retenidas por tópico: a 1 entrada cada 2 s son al menos 10 minutos (RF-6). */
  HISTORY_MAX_ENTRIES: positiveInt(300),
  /** A partir de aquí una fotografía es más barata que el detalle (RF-6). */
  MAX_REPLAY_ENTRIES: positiveInt(30),
  /** Pendiente de envío por encima del cual se deja de enviar detalle (RF-9). */
  SLOW_CLIENT_SOFT_BYTES: positiveInt(64 * 1024),
  /** Pendiente de envío por encima del cual se desconecta al cliente (RF-9). */
  SLOW_CLIENT_HARD_BYTES: positiveInt(256 * 1024),
  MAX_PUBLIC_CONNECTIONS: positiveInt(60_000),
  /** Debe superar la duración de la jornada: los reintentos llegan durante toda la ventana. */
  IDEM_TTL_SECONDS: positiveInt(24 * 3600),
  RATE_LIMIT_SUBMITS_PER_MINUTE: positiveInt(30),
  TOKEN_TTL_SECONDS: positiveInt(12 * 3600),
  METRICS_INTERVAL_MS: positiveInt(2_000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
