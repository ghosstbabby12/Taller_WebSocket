/** Se serializa una sola vez por envío: todos los suscriptores reciben el mismo Buffer. */
export const encodeSseEvent = (event: string, data: unknown): Buffer =>
  Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export const SSE_HEARTBEAT = Buffer.from(': hb\n\n');
