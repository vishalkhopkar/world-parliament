import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // integration tests spawn processes / servers: keep files sequential to avoid CPU starvation
    fileParallelism: false,
  },
});
