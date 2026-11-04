import { createResultsState } from '../public/js/results-state.js';

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Lee un flujo SSE con fetch. Sirve para el smoke test: para miles de conexiones pesa demasiado. */
export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith(':')) continue;
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

/** Cliente público real: usa el mismo reductor de estado que el navegador. */
export class PublicClient {
  readonly state = createResultsState();
  instance = '';
  redisStatus = 'up';
  eventCounts = { snapshot: 0, delta: 0 };
  private abort?: AbortController;
  private listeners = new Set<() => void>();

  constructor(
    private readonly baseUrl: string,
    private readonly topics: string[],
  ) {}

  /** Conecta con los cursores actuales y resuelve al recibir `hello`. */
  async connect(): Promise<void> {
    this.abort = new AbortController();
    const cursors = this.topics.map((t) => this.state.cursor(t) ?? '').join(',');
    const url = `${this.baseUrl}/api/public/stream?topics=${this.topics.join(',')}&cursors=${cursors}`;
    const response = await fetch(url, { signal: this.abort.signal });
    if (!response.ok) throw new Error(`Stream respondió ${response.status}`);

    const events = readSse(response);
    const first = await events.next();
    this.handle(first.value as SseEvent);
    void this.consume(events);
  }

  disconnect(): void {
    this.abort?.abort();
  }

  /** Espera hasta que el predicado se cumpla. */
  async until(predicate: () => boolean, timeoutMs = 10_000, what = 'condición'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Tiempo agotado esperando: ${what}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          this.listeners.delete(done);
          resolve();
        };
        this.listeners.add(done);
        setTimeout(done, 100);
      });
    }
  }

  private async consume(events: AsyncGenerator<SseEvent>): Promise<void> {
    try {
      for await (const event of events) this.handle(event);
    } catch {
      // Desconexión: el llamador decide si reconecta.
    }
  }

  private handle({ event, data }: SseEvent): void {
    const payload = data as Record<string, string>;
    if (event === 'hello') {
      this.instance = payload.instance ?? '';
      this.redisStatus = payload.redis ?? 'up';
    } else if (event === 'status') {
      this.redisStatus = payload.redis ?? 'up';
    } else if (event === 'snapshot') {
      this.eventCounts.snapshot += 1;
      this.state.applySnapshot(data);
    } else if (event === 'delta') {
      this.eventCounts.delta += 1;
      this.state.applyDelta(data);
    }
    for (const listener of [...this.listeners]) listener();
  }
}
