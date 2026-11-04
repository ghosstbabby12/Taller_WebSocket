import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Acta } from '../../src/domain/acta.js';
import { keys } from '../../src/infrastructure/redis/keys.js';
import { ENUNCIADO_ACTA, actaWith, correctedActa } from '../fixtures.js';
import { createTestRedis, createTestRepository, resetDatabase } from './helpers.js';

const redis = createTestRedis();
const repository = createTestRepository(redis);

const LEVELS = ['mesa:4201', 'puesto:176', 'mun:11', 'dep'];
const tally = (scope: string) => redis.hgetall(keys.tally(scope));

beforeEach(() => resetDatabase(redis));
afterAll(() => redis.quit());

describe('RF-1: idempotencia', () => {
  it('cinco reenvíos suman una sola vez y todos reciben respuesta', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await repository.submit(ENUNCIADO_ACTA));

    expect(results.map((r) => r.outcome === 'accepted' && r.status)).toEqual([
      'registered',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    for (const scope of LEVELS) {
      expect((await tally(scope))['v:C1']).toBe('184');
      expect((await tally(scope)).mesas_informadas).toBe('1');
    }
  });

  it('cinco reenvíos simultáneos también suman una sola vez', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.submit(ENUNCIADO_ACTA)),
    );
    const registered = results.filter((r) => r.outcome === 'accepted' && r.status === 'registered');
    expect(registered).toHaveLength(1);
    expect((await tally('dep'))['v:C1']).toBe('184');
  });

  it('si la instancia cae antes de confirmar, el reintento recibe el registro original', async () => {
    const original = await repository.submit(ENUNCIADO_ACTA); // La respuesta nunca llegó al jurado.
    const retry = await repository.submit(ENUNCIADO_ACTA); // Reintento contra otra instancia.
    expect(retry).toMatchObject({ status: 'duplicate' });
    expect(retry.outcome === 'accepted' && retry.receivedAt).toBe(
      original.outcome === 'accepted' && original.receivedAt,
    );
  });

  it('si la clave expira antes que el reintento, la identidad natural evita el doble conteo', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await redis.del(keys.idem(ENUNCIADO_ACTA.idem));
    expect(await repository.submit(ENUNCIADO_ACTA)).toMatchObject({ status: 'duplicate' });
    expect((await tally('dep'))['v:C1']).toBe('184');
  });

  it('rechaza la misma clave con otro contenido', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    const reused = { ...correctedActa(2, 10), idem: ENUNCIADO_ACTA.idem };
    expect(await repository.submit(reused)).toEqual({ outcome: 'rejected', code: 'IDEM_MISMATCH' });
    expect((await tally('dep'))['v:C1']).toBe('184');
  });

  it('rechaza una mesa que no pertenece al puesto declarado', async () => {
    const result = await repository.submit(actaWith({ mesa: 1 }));
    expect(result).toEqual({ outcome: 'rejected', code: 'UNKNOWN_MESA' });
  });
});

describe('RF-2: correcciones y convergencia', () => {
  it('la versión 2 revierte la anterior en los cuatro niveles', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await repository.submit(correctedActa(2, 10));
    for (const scope of LEVELS) {
      const values = await tally(scope);
      expect(values['v:C1']).toBe('174');
      expect(values['v:C2']).toBe('107');
      expect(values.mesas_informadas).toBe('1');
    }
  });

  it('una versión tardía no retrocede el estado', async () => {
    await repository.submit(correctedActa(3, 30));
    const late = await repository.submit(correctedActa(2, 20));
    expect(late).toMatchObject({ status: 'superseded', appliedVersion: 3 });
    expect((await tally('dep'))['v:C1']).toBe('154');
  });

  it('un acta dudosa no suma, y su corrección cuadrada la saca de la cola', async () => {
    const doubtful = actaWith({ sufragantes: 999 });
    expect(await repository.submit(doubtful)).toMatchObject({ status: 'in_review' });
    expect((await tally('dep'))['v:C1']).toBeUndefined();
    expect((await tally('dep')).en_verificacion).toBe('1');
    expect(await redis.zscore(keys.verificationQueue, doubtful.acta)).not.toBeNull();

    await repository.submit(correctedActa(2, 0));
    expect((await tally('dep'))['v:C1']).toBe('184');
    expect((await tally('dep')).en_verificacion).toBe('0');
    expect(await redis.zscore(keys.verificationQueue, doubtful.acta)).toBeNull();
  });

  it('una corrección dudosa retira el acta del conteo', async () => {
    await repository.submit(ENUNCIADO_ACTA);
    await repository.submit(actaWith({ version: 2, sufragantes: 1 }));
    const values = await tally('dep');
    expect(values['v:C1']).toBe('0');
    expect(values.mesas_informadas).toBe('0');
  });

  it('el resultado no depende del orden: todas las permutaciones convergen', async () => {
    const contradicting = correctedActa(2, 25); // Misma versión que otro envío, otro contenido.
    const set: Acta[] = [
      ENUNCIADO_ACTA,
      correctedActa(2, 10),
      contradicting,
      actaWith({ version: 3, sufragantes: 1 }), // Dudosa.
      correctedActa(4, 40),
    ];
    const finals = new Set<string>();
    for (const order of permutations(set)) {
      await resetDatabase(redis);
      for (const acta of order) await repository.submit(acta);
      finals.add(JSON.stringify(await observableState()));
    }
    expect(finals.size).toBe(1);
    // Debe ganar la mayor versión: 4, cuadrada, con 40 votos movidos.
    expect((await tally('dep'))['v:C1']).toBe('144');
  });

  it('dos contenidos de la misma versión convergen al mismo ganador, en verificación', async () => {
    const a = correctedActa(2, 5);
    const b = correctedActa(2, 7);
    const finals = new Set<string>();
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      await resetDatabase(redis);
      const results = [];
      for (const acta of order) results.push(await repository.submit(acta));
      expect(results[1]).toMatchObject({ status: 'conflict' });
      finals.add(JSON.stringify(await observableState()));
    }
    expect(finals.size).toBe(1);
    expect((await tally('dep')).mesas_informadas ?? '0').toBe('0');
    expect((await tally('dep')).en_verificacion).toBe('1');
    expect(await redis.zscore(keys.verificationQueue, a.acta)).not.toBeNull();
  });
});

/** Campos que dependen del contenido; se excluye lo que depende de cuándo llegó cada envío. */
async function observableState() {
  const acta = await redis.hgetall(keys.acta(ENUNCIADO_ACTA.acta));
  const levels = await Promise.all(LEVELS.map(tally));
  return {
    levels: levels.map(withoutZeros).map(sorted),
    acta: {
      version: acta.version,
      fp: acta.fp,
      doubtful: acta.doubtful,
      counted: acta.counted,
    },
    queue: await redis.zscore(keys.verificationQueue, ENUNCIADO_ACTA.acta),
  };
}

const withoutZeros = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '0'));

const sorted = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
