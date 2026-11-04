import type { Redis } from 'ioredis';
import { buildCatalog, type MesaLocation } from '../../domain/catalog.js';
import { scopesOf } from '../../domain/topics.js';
import { keys } from './keys.js';

const PIPELINE_CHUNK = 2_000;

/** Número de mesas de cada scope: es el denominador del porcentaje de mesas informadas (RF-3). */
export function mesasPerScope(catalog: readonly MesaLocation[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const location of catalog) {
    for (const scope of Object.values(scopesOf(location))) {
      totals.set(scope, (totals.get(scope) ?? 0) + 1);
    }
  }
  return totals;
}

/** Idempotente: repetirlo no toca votos. Se ejecuta antes de levantar las instancias. */
export async function seedCatalog(redis: Redis, catalog = buildCatalog()): Promise<void> {
  const commands: (string | number)[][] = catalog.map(({ mesa, puesto, municipio }) => [
    'hset',
    keys.catalog,
    mesa,
    `${puesto}:${municipio}`,
  ]);
  for (const [scope, total] of mesasPerScope(catalog)) {
    commands.push(['hset', keys.tally(scope), 'mesas_totales', total]);
    commands.push(['hset', keys.pub(scope), 'mesas_totales', total]);
  }
  for (let i = 0; i < commands.length; i += PIPELINE_CHUNK) {
    await redis.pipeline(commands.slice(i, i + PIPELINE_CHUNK) as string[][]).exec();
  }
  await redis.set(keys.seedDone, '1');
}

export const isSeeded = async (redis: Redis) => (await redis.exists(keys.seedDone)) === 1;
