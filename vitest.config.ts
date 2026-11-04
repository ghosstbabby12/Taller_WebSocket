import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Las pruebas de integración comparten una base de Redis: no pueden correr en paralelo.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
