import { describe, expect, it } from 'vitest';
import { actaSchema, fingerprint, isDoubtful } from '../../src/domain/acta.js';
import { decideBackpressure } from '../../src/domain/backpressure.js';
import { CATALOG_SIZE, buildCatalog } from '../../src/domain/catalog.js';
import { planRecovery } from '../../src/domain/recovery.js';
import { isTopic } from '../../src/domain/topics.js';
import { ENUNCIADO_ACTA, actaWith } from '../fixtures.js';

describe('acta', () => {
  it('acepta el mensaje de ejemplo del enunciado y lo considera cuadrado', () => {
    const acta = actaSchema.parse(ENUNCIADO_ACTA);
    expect(isDoubtful(acta)).toBe(false);
  });

  it('marca como dudosa el acta cuyos votos no suman los sufragantes', () => {
    expect(isDoubtful(actaWith({ sufragantes: 628 }))).toBe(true);
  });

  it('rechaza votos negativos, opciones desconocidas y puesto incoherente', () => {
    const invalid = [
      actaWith({ votos: { ...ENUNCIADO_ACTA.votos, C1: -1 } }),
      actaWith({ votos: { ...ENUNCIADO_ACTA.votos, HACK: 1 } }),
      actaWith({ puesto: 177 }),
    ];
    for (const acta of invalid) expect(actaSchema.safeParse(acta).success).toBe(false);
  });

  it('la huella ignora el orden de los votos y los datos del envío', () => {
    const reordered = actaWith({
      votos: { NO_MARCADO: 4, NULO: 9, BLANCO: 22, C3: 311, C2: 97, C1: 184 },
      idem: 'otro-envio',
      jurado: 'JUR-1',
    });
    expect(fingerprint(reordered)).toBe(fingerprint(ENUNCIADO_ACTA));
  });
});

describe('catálogo', () => {
  const catalog = buildCatalog();

  it('tiene exactamente las mesas, puestos y municipios esperados', () => {
    expect(catalog).toHaveLength(CATALOG_SIZE.mesas);
    expect(new Set(catalog.map((m) => m.puesto)).size).toBe(CATALOG_SIZE.puestos);
    expect(new Set(catalog.map((m) => m.municipio)).size).toBe(CATALOG_SIZE.municipios);
  });

  it('ubica la mesa del ejemplo del enunciado donde dice el enunciado', () => {
    expect(catalog[4200]).toEqual({ mesa: 4201, puesto: 176, municipio: 11 });
  });

  it('cada puesto pertenece a un solo municipio', () => {
    const municipioByPuesto = new Map<number, number>();
    for (const { puesto, municipio } of catalog) {
      expect(municipioByPuesto.get(puesto) ?? municipio).toBe(municipio);
      municipioByPuesto.set(puesto, municipio);
    }
  });
});

describe('planRecovery', () => {
  const plan = (cursor: number | undefined, currentSeq: number, prevs: number[]) =>
    planRecovery({
      cursor,
      currentSeq,
      entries: prevs.map((prev, i) => ({ prev, seq: prev + i + 1 })),
      maxReplay: 3,
    });

  it('fotografía para el cliente nuevo y el cursor de otra época', () => {
    expect(plan(undefined, 10, [])).toBe('snapshot');
    expect(plan(11, 10, [])).toBe('snapshot');
  });

  it('nada que hacer si ya está al día', () => {
    expect(plan(10, 10, [])).toBe('up_to_date');
  });

  it('detalle solo si está completo y es pequeño', () => {
    expect(plan(8, 10, [8, 9])).toBe('replay');
    expect(plan(8, 10, [9, 10])).toBe('snapshot'); // Hueco por recorte.
    expect(plan(8, 10, [])).toBe('snapshot'); // Historial vacío con cambios.
    expect(plan(1, 10, [1, 2, 3, 4])).toBe('snapshot'); // Más que el máximo.
  });
});

describe('decideBackpressure', () => {
  const limits = { softBytes: 100, hardBytes: 200 };

  it('aplica los umbrales', () => {
    expect(decideBackpressure(99, false, limits)).toBe('send');
    expect(decideBackpressure(100, false, limits)).toBe('skip');
    expect(decideBackpressure(200, false, limits)).toBe('disconnect');
  });

  it('quien ya omite no recibe detalle hasta drenar', () => {
    expect(decideBackpressure(0, true, limits)).toBe('skip');
  });
});

describe('isTopic', () => {
  it('solo acepta tópicos públicos bien formados', () => {
    for (const valid of ['dep', 'mun:11', 'puesto:176']) expect(isTopic(valid)).toBe(true);
    for (const invalid of ['mesa:1', 'mun:', 'mun:0', 'dep:1', 'x']) {
      expect(isTopic(invalid)).toBe(false);
    }
  });
});
