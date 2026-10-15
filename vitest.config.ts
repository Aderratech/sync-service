import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // The repo path contains a space; threads avoid fork path issues on Windows.
    pool: 'threads',
    // Integration tests share one local database; keep files sequential.
    fileParallelism: false,
  },
});
