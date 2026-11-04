import type { Redis } from 'ioredis';
import type { TopicDelta } from '../../domain/results.js';
import type { Topic } from '../../domain/topics.js';
import { keys, scopeFromChannel } from './keys.js';
import type { ResultsRepository } from './results-repository.js';

const BACKFILL_LIMIT = 1_000;

export interface BackplaneHandlers {
  onDelta: (delta: TopicDelta) => void;
  /** El historial ya no cubre lo perdido: los clientes de ese tópico necesitan fotografía. */
  onResyncRequired: (topic: Topic) => void;
}

interface TopicState {
  lastSeq: number;
  subscribed: Promise<void>;
  /** Serializa el procesamiento: un relleno en curso no puede ser adelantado por un mensaje vivo. */
  chain: Promise<void>;
}

/**
 * Difusión entre instancias con un canal por tópico: cada instancia solo se suscribe a lo que sus
 * clientes miran, así que un puesto sin audiencia local no genera tráfico hacia ella.
 *
 * Pub/Sub es solo el aviso rápido y no tiene memoria. La verdad está en los Streams: un mensaje cuyo
 * `prev` no coincide delata un hueco, y este se rellena con el historial. Lo mismo ocurre al
 * reconectar con Redis, cuando pudo perderse cualquier cosa.
 */
export class RedisBackplane {
  private readonly topics = new Map<Topic, TopicState>();

  constructor(
    private readonly subscriber: Redis,
    private readonly repository: ResultsRepository,
    private readonly handlers: BackplaneHandlers,
    private readonly onError: (error: unknown) => void,
  ) {
    subscriber.on('message', (channel: string, raw: string) => {
      const topic = scopeFromChannel(channel) as Topic;
      this.enqueue(topic, () => this.handleLive(topic, JSON.parse(raw) as TopicDelta));
    });
    // 'ready' también se emite en la primera conexión; sin tópicos el recorrido no hace nada.
    subscriber.on('ready', () => {
      for (const topic of this.topics.keys()) this.enqueue(topic, () => this.backfill(topic));
    });
  }

  /** Al resolver, la suscripción está activa: lo que se lea después de esto no se pierde. */
  async subscribe(topic: Topic): Promise<void> {
    const existing = this.topics.get(topic);
    if (existing) return existing.subscribed;

    const state: TopicState = {
      lastSeq: 0,
      chain: Promise.resolve(),
      subscribed: Promise.resolve(),
    };
    state.subscribed = this.activate(topic, state);
    this.topics.set(topic, state);
    return state.subscribed;
  }

  private async activate(topic: Topic, state: TopicState): Promise<void> {
    try {
      await this.subscriber.subscribe(keys.channel(topic));
      state.lastSeq = Math.max(state.lastSeq, await this.repository.currentSeq(topic));
    } catch (error) {
      // No dejar una suscripción a medias: el siguiente cliente debe poder reintentarla.
      if (this.topics.get(topic) === state) this.topics.delete(topic);
      throw error;
    }
  }

  async unsubscribe(topic: Topic): Promise<void> {
    this.topics.delete(topic);
    await this.subscriber.unsubscribe(keys.channel(topic));
  }

  private enqueue(topic: Topic, task: () => Promise<void>): void {
    const state = this.topics.get(topic);
    if (!state) return;
    state.chain = state.chain.then(task).catch(this.onError);
  }

  private async handleLive(topic: Topic, delta: TopicDelta): Promise<void> {
    const state = this.topics.get(topic);
    if (!state || delta.seq <= state.lastSeq) return;
    if (state.lastSeq !== 0 && delta.prev > state.lastSeq) await this.backfill(topic);
    if (delta.seq <= state.lastSeq) return;
    state.lastSeq = delta.seq;
    this.handlers.onDelta(delta);
  }

  private async backfill(topic: Topic): Promise<void> {
    const state = this.topics.get(topic);
    if (!state) return;
    const [read] = await this.repository.readRecovery(
      [{ topic, cursor: state.lastSeq }],
      BACKFILL_LIMIT,
    );
    if (!read) return;

    const first = read.entries[0];
    const historyHasHole = first ? first.prev > state.lastSeq : read.currentSeq > state.lastSeq;
    if (historyHasHole) {
      state.lastSeq = read.currentSeq;
      this.handlers.onResyncRequired(topic);
      return;
    }
    for (const entry of read.entries) {
      state.lastSeq = entry.seq;
      this.handlers.onDelta(entry);
    }
  }
}
