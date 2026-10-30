import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    // Port 1 is never listening, so readiness failure is deterministic even if a local DB runs.
    env: { POSTGRES_PORT: '1', REDIS_PORT: '1', LOG_LEVEL: 'silent' },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
