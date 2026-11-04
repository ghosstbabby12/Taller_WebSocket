/**
 * Backoff exponencial con jitter completo (RF-10): espera un valor uniforme en [0, tope]. Es lo que
 * reparte en el tiempo a 50.000 clientes que perdieron la misma instancia en el mismo instante.
 */
export function fullJitterDelay(
  attempt,
  { baseMs = 1000, capMs = 30000 } = {},
  random = Math.random,
) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
