import type { TopicSnapshot } from '../domain/results.js';
import type { Topic } from '../domain/topics.js';
import type { ResultsRepository } from '../infrastructure/redis/results-repository.js';

const CACHE_TTL_MS = 1_000;

interface CacheEntry {
  expiresAt: number;
  value: Promise<TopicSnapshot[]>;
}

const cacheKey = (topics: readonly Topic[]) => [...topics].sort().join(',');

/**
 * Lectura de fotografías con caché breve y llamada única: una avalancha de reconexión (RF-10) pide
 * miles de veces lo mismo, y Redis debe atender una sola lectura por combinación de tópicos.
 */
export class SnapshotService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repository: ResultsRepository) {}

  read(topics: readonly Topic[]): Promise<TopicSnapshot[]> {
    const key = cacheKey(topics);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    this.evictExpired(now);
    const value = this.repository.readSnapshots(topics);
    const entry = { expiresAt: now + CACHE_TTL_MS, value };
    this.cache.set(key, entry);
    // Un error no se cachea: el siguiente intento vuelve a Redis.
    value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return value;
  }

  /**
   * Fotografía garantizada al menos tan nueva como `minSeq`. Un cliente que reconecta no puede
   * recibir una copia de caché anterior a lo ya publicado: se saltaría esa ventana.
   */
  async readAtLeast(minSeq: ReadonlyMap<Topic, number>): Promise<TopicSnapshot[]> {
    const topics = [...minSeq.keys()];
    const cached = await this.read(topics);
    if (cached.every(({ topic, seq }) => seq >= (minSeq.get(topic) ?? 0))) return cached;
    this.cache.delete(cacheKey(topics));
    return this.read(topics);
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
