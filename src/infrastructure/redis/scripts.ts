import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';

const SCRIPTS = {
  submitActa: { file: 'submit_acta.lua', numberOfKeys: 12 },
  flushWindow: { file: 'flush_window.lua', numberOfKeys: 6 },
  readSnapshot: { file: 'read_snapshot.lua', numberOfKeys: 0 },
  readRecovery: { file: 'read_recovery.lua', numberOfKeys: 0 },
  rateLimit: { file: 'rate_limit.lua', numberOfKeys: 1 },
} as const;

type ScriptName = keyof typeof SCRIPTS;

export type ScriptedRedis = Redis & {
  [name in ScriptName]: (...args: (string | number)[]) => Promise<never>;
};

/** Registra los scripts: ioredis los ejecuta con EVALSHA y cae a EVAL si Redis no los conoce. */
export function registerScripts(redis: Redis): ScriptedRedis {
  for (const [name, { file, numberOfKeys }] of Object.entries(SCRIPTS)) {
    const lua = readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');
    redis.defineCommand(name, { lua, numberOfKeys });
  }
  return redis as ScriptedRedis;
}
