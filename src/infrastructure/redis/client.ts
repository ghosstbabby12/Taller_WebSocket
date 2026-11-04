import { Redis, type RedisOptions } from 'ioredis';

/**
 * Sin cola offline y con tiempo límite: si Redis no responde, el comando FALLA en vez de quedar
 * esperando. Es la base de RF-10: un jurado nunca debe creer que transmitió mientras su acta espera
 * en la memoria de una instancia que puede morir.
 */
const FAIL_FAST: RedisOptions = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
};

export const createCommandClient = (url: string) => new Redis(url, FAIL_FAST);

/** Una conexión en modo suscriptor no admite otros comandos y debe resuscribirse sola. */
export const createSubscriberClient = (url: string) =>
  new Redis(url, {
    enableOfflineQueue: true,
    autoResubscribe: true,
    maxRetriesPerRequest: null,
    retryStrategy: FAIL_FAST.retryStrategy!,
  });
