import { keys } from './keys.js';
import type { ScriptedRedis } from './scripts.js';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/** Límite de tasa por credencial con ventana fija (sección 5, papel «Límite de tasa»). */
export class RateLimiter {
  constructor(private readonly redis: ScriptedRedis) {}

  async consume(credential: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const window = Math.floor(Date.now() / windowMs);
    const [count, ttl]: [number, number] = await this.redis.rateLimit(
      keys.rateLimit(credential, window),
      windowMs,
    );
    return { allowed: count <= limit, retryAfterMs: count <= limit ? 0 : ttl };
  }
}
