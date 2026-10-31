import { existsSync } from 'node:fs';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// E2E needs a real PostgreSQL (`docker compose up -d postgres`): the global setup creates and
// migrates TEST_DATABASE_URL, whose name must end with _test. Unit tests (`pnpm test`) stay DB-free.
// Files run one at a time because they share that database.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    globalSetup: ['test/setup/integration-global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Port 1 is never listening, so readiness failure is deterministic even if a local DB runs.
      // Suites that need data use createTestApp(), which switches to the _test database.
      DATABASE_URL: 'postgresql://salesflow:unused@localhost:1/salesflow',
      REDIS_PORT: '1',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'e2e-test-secret-e2e-test-secret-0123456789',
      // Effectively off, so only the dedicated throttling suite ever sees a 429.
      THROTTLE_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
