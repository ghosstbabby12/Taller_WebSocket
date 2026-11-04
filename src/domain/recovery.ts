/** Entrada del historial de un tópico. `prev` encadena con la entrada anterior de ese tópico. */
export interface HistoryEntry {
  seq: number;
  prev: number;
}

export type RecoveryPlan = 'up_to_date' | 'replay' | 'snapshot';

/**
 * Decide cómo poner al día a un cliente que vuelve con `cursor` (RF-6). Regla de seguridad: solo se
 * reproduce el detalle si se puede demostrar que está completo; ante la duda, fotografía.
 */
export function planRecovery(input: {
  cursor: number | undefined;
  currentSeq: number;
  entries: readonly HistoryEntry[];
  maxReplay: number;
}): RecoveryPlan {
  const { cursor, currentSeq, entries, maxReplay } = input;

  if (cursor === undefined) return 'snapshot'; // Cliente nuevo.
  if (cursor > currentSeq) return 'snapshot'; // El cursor es de otra época: se reinició el estado.
  if (cursor === currentSeq) return 'up_to_date';

  const first = entries[0];
  if (!first) return 'snapshot'; // Hubo cambios, pero el historial ya no los tiene.
  if (first.prev > cursor) return 'snapshot'; // El recorte se llevó entradas intermedias.
  if (entries.length > maxReplay) return 'snapshot'; // La fotografía sale más barata.
  return 'replay';
}
