import { createHash } from 'node:crypto';
import { z } from 'zod';

const voteCount = z.number().int().nonnegative();
const REQUIRED_NON_CANDIDATE_OPTIONS = ['BLANCO', 'NULO', 'NO_MARCADO'] as const;
const OPTION_PATTERN = /^(C\d+|BLANCO|NULO|NO_MARCADO)$/;

/** Mensaje de transmisión de acta (sección 3.1 del enunciado). */
export const actaSchema = z
  .object({
    acta: z.string().regex(/^E14-\d{1,4}-\d{4}-\d{2}$/, 'Formato esperado: E14-puesto-mesa-corp'),
    mesa: z.number().int().positive(),
    puesto: z.number().int().positive(),
    municipio: z.number().int().positive(),
    version: z.number().int().positive(),
    jurado: z.string().regex(/^JUR-\d+$/),
    ts_cierre: z.number().int().positive(),
    votos: z.record(z.string().regex(OPTION_PATTERN), voteCount),
    sufragantes: voteCount,
    hash_foto: z.string().min(1).max(128),
    idem: z.string().min(8).max(64),
  })
  .refine((a) => REQUIRED_NON_CANDIDATE_OPTIONS.every((option) => option in a.votos), {
    path: ['votos'],
    message: 'Faltan BLANCO, NULO o NO_MARCADO',
  })
  .refine((a) => Number(a.acta.split('-')[1]) === a.puesto, {
    path: ['puesto'],
    message: 'El puesto no coincide con el identificador del acta',
  });

export type Acta = z.infer<typeof actaSchema>;

const totalVotes = (acta: Acta) => Object.values(acta.votos).reduce((sum, n) => sum + n, 0);

/** Regla contable de 3.1: si la suma no da los sufragantes, el acta pasa a verificación humana. */
export const isDoubtful = (acta: Acta) => totalVotes(acta) !== acta.sufragantes;

/**
 * Menor puntaje = se atiende primero. Un acta con mayor descuadre puede mover más el resultado
 * publicado, así que se revisa antes.
 */
export const verificationPriority = (acta: Acta) => -Math.abs(totalVotes(acta) - acta.sufragantes);

/**
 * Identidad del contenido de una versión. Excluye `idem`, `jurado` y `ts_cierre`, que describen el
 * envío y no el resultado. Junto con `version` da el orden total que hace convergente a RF-2.
 */
export function fingerprint(acta: Acta): string {
  const votos = Object.keys(acta.votos)
    .sort()
    .map((option) => [option, acta.votos[option]]);
  const canonical = JSON.stringify([
    acta.mesa,
    acta.puesto,
    acta.municipio,
    votos,
    acta.sufragantes,
    acta.hash_foto,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
