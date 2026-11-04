import type { Topic } from './topics.js';

/** Explicación pública de por qué un número cambió o retrocedió (sección 2, audiencia Público). */
export interface Correction {
  acta: string;
  mesa: number;
  puesto: number;
  municipio: number;
  fromVersion: number;
  toVersion: number;
  reason: 'correction' | 'under_review';
  at: number;
}

/** Delta mínimo de una ventana: solo los campos que cambiaron, con su valor absoluto. */
export interface TopicDelta {
  topic: Topic;
  seq: number;
  prev: number;
  at: number;
  changes: Record<string, number>;
  corrections?: Correction[];
}

export interface TopicSnapshot {
  topic: Topic;
  seq: number;
  state: Record<string, number>;
  ranking: { candidate: string; votes: number }[];
  corrections: Correction[];
}

export type SubmissionStatus =
  | 'registered' // Aplicada al acumulado.
  | 'in_review' // Registrada, pero dudosa: va a verificación y no suma todavía.
  | 'duplicate' // Ya estaba: reenvío. Lleva la fecha del registro original.
  | 'superseded' // Ya hay una versión posterior: esta no cambia nada.
  | 'conflict'; // Misma versión con otro contenido: a verificación.

export type SubmissionRejection = 'IDEM_MISMATCH' | 'UNKNOWN_MESA';

export type SubmissionResult =
  | {
      outcome: 'accepted';
      status: SubmissionStatus;
      acta: string;
      version: number;
      appliedVersion: number;
      receivedAt: number;
    }
  | { outcome: 'rejected'; code: SubmissionRejection };
