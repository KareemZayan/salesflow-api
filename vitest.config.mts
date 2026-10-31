import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so Vitest emits decorator metadata that NestJS DI relies on.
// Unit tests never touch a database: DATABASE_URL points at a port nothing listens on (Prisma
// connects lazily), and the auth secret is a throwaway value, so no .env is needed.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    env: {
      DATABASE_URL: 'postgresql://salesflow:unused@localhost:1/salesflow',
      JWT_ACCESS_SECRET: 'unit-test-secret-unit-test-secret-0123456789',
      LOG_LEVEL: 'silent',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
