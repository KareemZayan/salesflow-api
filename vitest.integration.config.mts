import { existsSync } from 'node:fs';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests hit a real PostgreSQL (TEST_DATABASE_URL, name must end with _test).
// Needs `docker compose up -d postgres`. Files run one at a time because they share the database.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration-spec.ts'],
    globalSetup: ['test/setup/integration-global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
