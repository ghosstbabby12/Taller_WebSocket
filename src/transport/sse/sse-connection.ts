import type { ServerResponse } from 'node:http';
import { decideBackpressure, type BackpressureLimits } from '../../domain/backpressure.js';
import type { Topic } from '../../domain/topics.js';

export interface DeltaFrame {
  topic: Topic;
  seq: number;
  payload: Buffer;
}

export interface SseConnectionEvents {
  /** El cliente lento se puso al día: necesita una fotografía al menos tan nueva como lo omitido. */
  onCaughtUp: (connection: SseConnection, minSeq: ReadonlyMap<Topic, number>) => void;
  onDeltaWritten: () => void;
  onSkipped: () => void;
  onDisconnectedSlow: () => void;
}

/**
 * Una conexión pública. Mientras está sincronizando (al abrir o tras omitir detalle) los deltas se
 * guardan en vez de escribirse: si se escribieran, podrían adelantarse a la fotografía en camino.
 */
export class SseConnection {
  private syncing = true;
  private pendingDuringSync: DeltaFrame[] = [];
  private skipped = new Map<Topic, number>();

  constructor(
    private readonly response: Pick<
      ServerResponse,
      'write' | 'writableLength' | 'destroy' | 'end' | 'once'
    >,
    private readonly limits: BackpressureLimits,
    private readonly events: SseConnectionEvents,
  ) {}

  /** Escritura directa de control (fotografía, estado, latido), sin la política de detalle. */
  writeRaw(payload: Buffer): void {
    this.response.write(payload);
  }

  deliverDelta(frame: DeltaFrame): void {
    if (this.syncing) {
      this.pendingDuringSync.push(frame);
      return;
    }
    const decision = decideBackpressure(
      this.response.writableLength,
      this.skipped.size > 0,
      this.limits,
    );
    if (decision === 'disconnect') {
      this.events.onDisconnectedSlow();
      this.response.destroy();
      return;
    }
    if (decision === 'skip') {
      this.skip(frame);
      return;
    }
    this.response.write(frame.payload);
    this.events.onDeltaWritten();
  }

  beginSync(): void {
    this.syncing = true;
  }

  /** Vuelca lo acumulado, descartando lo que la recuperación ya cubrió (`syncedSeq` por tópico). */
  finishSync(syncedSeq: ReadonlyMap<Topic, number>): void {
    this.syncing = false;
    const pending = this.pendingDuringSync;
    this.pendingDuringSync = [];
    for (const frame of pending) {
      if (frame.seq > (syncedSeq.get(frame.topic) ?? 0)) this.deliverDelta(frame);
    }
  }

  close(finalPayload?: Buffer): void {
    if (finalPayload) this.response.end(finalPayload);
    else this.response.end();
  }

  private skip({ topic, seq }: DeltaFrame): void {
    this.events.onSkipped();
    const wasCaughtUp = this.skipped.size === 0;
    this.skipped.set(topic, seq);
    if (!wasCaughtUp) return;
    // Por encima de 16 KiB write() ya devolvió false, así que 'drain' está garantizado.
    this.response.once('drain', () => {
      const minSeq = this.skipped;
      this.skipped = new Map();
      this.events.onCaughtUp(this, minSeq);
    });
  }
}
