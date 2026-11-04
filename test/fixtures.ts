import type { Acta } from '../src/domain/acta.js';

/** Mensaje de la sección 3.1 del enunciado, tal cual. */
export const ENUNCIADO_ACTA: Acta = {
  acta: 'E14-176-0042-03',
  mesa: 4201,
  puesto: 176,
  municipio: 11,
  version: 1,
  jurado: 'JUR-88134',
  ts_cierre: 1793577600,
  votos: { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 },
  sufragantes: 627,
  hash_foto: '9f2c...',
  idem: '8f14e45fceea167a',
};

let counter = 0;

/** Variante del acta de ejemplo con una clave de idempotencia nueva. */
export function actaWith(overrides: Partial<Acta>): Acta {
  counter += 1;
  return { ...ENUNCIADO_ACTA, idem: `test-idem-${counter}`, ...overrides };
}

/** Variante cuadrada: mueve votos de C1 a C2 sin cambiar el total. */
export function correctedActa(version: number, moved: number): Acta {
  return actaWith({
    version,
    votos: {
      ...ENUNCIADO_ACTA.votos,
      C1: ENUNCIADO_ACTA.votos.C1! - moved,
      C2: ENUNCIADO_ACTA.votos.C2! + moved,
    },
  });
}
