const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Job<Connection> {
  targets: Iterable<Connection>;
  deliver: (connection: Connection) => void;
}

/**
 * Reparte un envío en lotes y cede el Event Loop entre ellos (RF-4, RT-4). `setImmediate` corre
 * después de la fase de I/O: entre dos lotes se atienden sockets, y un jurado que transmite no
 * espera a que termine el recorrido de 50.000 conexiones.
 *
 * Los trabajos corren en FIFO, uno a la vez: dos ventanas consecutivas de un mismo tópico llegan a
 * cada cliente en orden aunque el primer envío siga en curso.
 */
export class BatchedBroadcaster<Connection> {
  private readonly queue: Job<Connection>[] = [];
  private draining = false;

  constructor(private readonly batchSize: number) {}

  /** `targets` se recorre con cesiones de por medio: una baja durante el envío se respeta. */
  broadcast(targets: Iterable<Connection>, deliver: (connection: Connection) => void): void {
    this.queue.push({ targets, deliver });
    if (!this.draining) void this.drain();
  }

  /** Métrica de saturación: si crece de forma sostenida, el fan-out no da abasto. */
  get pendingJobs() {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    let job: Job<Connection> | undefined;
    while ((job = this.queue.shift())) {
      let sentInBatch = 0;
      for (const target of job.targets) {
        job.deliver(target);
        if (++sentInBatch >= this.batchSize) {
          sentInBatch = 0;
          await yieldToEventLoop();
        }
      }
      await yieldToEventLoop();
    }
    this.draining = false;
  }
}
