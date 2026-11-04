import { Redis } from 'ioredis';
import { seedCatalog } from './infrastructure/redis/seed.js';

const { REDIS_URL } = process.env;
if (!REDIS_URL) throw new Error('Falta REDIS_URL');

const redis = new Redis(REDIS_URL);
await seedCatalog(redis);
await redis.quit();
console.log('Catálogo sembrado');
