import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

// Phase 15b through the real application build (AppModule + configureApp), the way main.ts starts it.
// The environment is set explicitly for every key a case cares about and never deleted: ConfigModule
// also reads .env, so a deleted variable would silently fall back to the developer's file. A missing
// NODE_ENV is therefore covered where validation can see a bare object (validate-env.spec.ts).
const KEYS = [
  'NODE_ENV',
  'REDIS_PASSWORD',
  'TRUST_PROXY',
  'CORS_ORIGINS',
  'QUEUE_BOARD_ENABLED',
] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

const PRODUCTION: Env = {
  NODE_ENV: 'production',
  REDIS_PASSWORD: 'a-real-secret',
  TRUST_PROXY: '1',
  CORS_ORIGINS: 'https://app.example.com',
  QUEUE_BOARD_ENABLED: 'false',
};

async function startApp(env: Env) {
  vi.resetModules();
  // Every key is set (a blank means "unset", except the flag, which must stay a valid value).
  for (const key of KEYS)
    process.env[key] = env[key] ?? (key === 'QUEUE_BOARD_ENABLED' ? 'false' : '');
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/app.setup.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('Production configuration (e2e)', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  let app: INestApplication | undefined;

  // The Logger class is loaded after vi.resetModules() like everything else, so spy on the one the
  // freshly imported application will use.
  const spyOnConfigWarnings = async () => {
    const { Logger } = await import('@nestjs/common');
    return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  };
  const configWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls
      .map(([message]) => String(message))
      .filter((m) => /TRUST_PROXY|CORS_ORIGINS/.test(m));

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  describe('fails fast', () => {
    it('production without a Redis password does not start', async () => {
      await expect(startApp({ ...PRODUCTION, REDIS_PASSWORD: '' })).rejects.toThrow(
        /REDIS_PASSWORD: is required when NODE_ENV=production/,
      );
    });

    it('production with only whitespace as the Redis password does not start', async () => {
      await expect(startApp({ ...PRODUCTION, REDIS_PASSWORD: '   ' })).rejects.toThrow(
        /REDIS_PASSWORD/,
      );
    });

    it('an unsupported NODE_ENV does not start, whatever .env says', async () => {
      await expect(startApp({ ...PRODUCTION, NODE_ENV: 'staging' })).rejects.toThrow(
        /NODE_ENV: must be one of development, test, production/,
      );
    });
  });

  describe('a correctly configured production', () => {
    it('starts, warns about nothing, and keeps Swagger off', async () => {
      const warn = await spyOnConfigWarnings();

      app = await startApp(PRODUCTION);

      expect(configWarnings(warn)).toEqual([]);
      await request(app.getHttpServer()).get('/api/docs').expect(404);
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
      const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('warns, but starts', () => {
    it('TRUST_PROXY=false in production', async () => {
      const warn = await spyOnConfigWarnings();

      app = await startApp({ ...PRODUCTION, TRUST_PROXY: 'false' });

      const warnings = configWarnings(warn);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/TRUST_PROXY is false/);
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('an empty CORS_ORIGINS in production', async () => {
      const warn = await spyOnConfigWarnings();

      app = await startApp({ ...PRODUCTION, CORS_ORIGINS: '' });

      const warnings = configWarnings(warn);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/CORS_ORIGINS is empty/);
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('both at once, one warning each', async () => {
      const warn = await spyOnConfigWarnings();

      app = await startApp({ ...PRODUCTION, TRUST_PROXY: 'false', CORS_ORIGINS: '' });

      expect(configWarnings(warn)).toHaveLength(2);
    });
  });

  describe('development and test keep working without noise', () => {
    it.each(['development', 'test'])(
      '%s with the production-warning settings unset: starts, no warnings, no Redis password needed',
      async (nodeEnv) => {
        const warn = await spyOnConfigWarnings();

        app = await startApp({ NODE_ENV: nodeEnv, TRUST_PROXY: 'false', CORS_ORIGINS: '' });

        expect(configWarnings(warn)).toEqual([]);
        await request(app.getHttpServer()).get('/health').expect(200);
      },
    );

    it('development still serves Swagger', async () => {
      app = await startApp({ NODE_ENV: 'development', TRUST_PROXY: 'false', CORS_ORIGINS: '' });

      await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    });
  });
});
