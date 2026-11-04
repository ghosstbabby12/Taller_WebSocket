import type { ResultsRepository } from '../infrastructure/redis/results-repository.js';

/**
 * Dispara la publicación por ventana (RF-4). Todas las instancias lo intentan; la guarda en Redis
 * deja pasar a una sola. Así, si muere la que venía publicando, nadie tiene que hacer nada.
 */
export class WindowFlusher {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: ResultsRepository,
    private readonly options: { windowMs: number; instanceId: string },
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    const { windowMs, instanceId } = this.options;
    // La guarda vence antes que la ventana para que el desfase entre relojes no salte una ventana.
    const guardTtlMs = Math.floor(windowMs * 0.9);
    this.timer = setInterval(() => {
      this.repository.flushWindow(guardTtlMs, instanceId).catch(this.onError);
    }, windowMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
