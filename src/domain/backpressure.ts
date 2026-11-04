export interface BackpressureLimits {
  softBytes: number;
  hardBytes: number;
}

export type BackpressureDecision = 'send' | 'skip' | 'disconnect';

/**
 * Política de RF-9 según los bytes pendientes de la conexión:
 * - bajo el umbral suave: se envía el detalle;
 * - sobre el umbral suave: se omite el detalle y se manda una fotografía cuando el cliente drene;
 * - sobre el umbral duro: se desconecta; el cliente vuelve con su cursor (RF-6).
 *
 * Una conexión que ya está omitiendo no vuelve a recibir detalle hasta drenar, aunque baje del
 * umbral: si recibiera detalle ahora, tendría un hueco que solo la fotografía repara.
 */
export function decideBackpressure(
  pendingBytes: number,
  alreadySkipping: boolean,
  limits: BackpressureLimits,
): BackpressureDecision {
  if (pendingBytes >= limits.hardBytes) return 'disconnect';
  if (alreadySkipping || pendingBytes >= limits.softBytes) return 'skip';
  return 'send';
}
