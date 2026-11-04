import type { Redis } from 'ioredis';

/** Estado observado de Redis, para que el sistema degrade de forma explícita (RF-10). */
export class RedisHealth {
  private available = false;
  private readonly listeners = new Set<(available: boolean) => void>();

  constructor(redis: Redis) {
    this.available = redis.status === 'ready';
    redis.on('ready', () => this.update(true));
    redis.on('close', () => this.update(false));
    redis.on('end', () => this.update(false));
  }

  get isAvailable() {
    return this.available;
  }

  onChange(listener: (available: boolean) => void): void {
    this.listeners.add(listener);
  }

  private update(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    for (const listener of this.listeners) listener(available);
  }
}
