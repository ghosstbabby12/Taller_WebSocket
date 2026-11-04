import { Redis } from 'ioredis';
import { buildCatalog } from '../../src/domain/catalog.js';
import { ResultsRepository } from '../../src/infrastructure/redis/results-repository.js';
import { registerScripts, type ScriptedRedis } from '../../src/infrastructure/redis/scripts.js';
import { seedCatalog } from '../../src/infrastructure/redis/seed.js';

/** Base 15: nunca la que usa el stack (base 0). Las pruebas la vacían sin miramientos. */
const TEST_REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15';

export const createTestRedis = () => registerScripts(new Redis(TEST_REDIS_URL));

export const createTestRepository = (redis: ScriptedRedis, historyMaxEntries = 300) =>
  new ResultsRepository(redis, { idemTtlSeconds: 3600, historyMaxEntries });

const CATALOG = buildCatalog();

export async function resetDatabase(redis: ScriptedRedis): Promise<void> {
  await redis.flushdb();
  await seedCatalog(redis, CATALOG);
}

/** Publica ignorando la guarda de ventana: las pruebas deciden cuándo termina cada ventana. */
export const flush = (repository: ResultsRepository) => repository.flushWindow(1, 'test');

export const waitForGuard = () => new Promise((resolve) => setTimeout(resolve, 3));
