import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so Vitest emits decorator metadata that NestJS DI relies on.
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
