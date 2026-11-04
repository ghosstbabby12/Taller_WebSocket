// tsc no copia archivos que no son TypeScript: los scripts Lua se llevan a mano a dist/.
import { cpSync } from 'node:fs';

cpSync('src/infrastructure/redis/lua', 'dist/infrastructure/redis/lua', { recursive: true });
