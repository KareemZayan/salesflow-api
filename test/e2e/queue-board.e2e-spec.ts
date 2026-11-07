import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

// AppModule decides at import time whether Bull Board is part of the module graph (it reads the
// environment right after ConfigModule loads it), so each case sets the environment, resets the
// module registry and imports the application afresh.
const BOARD_PATH = '/api/v1/queues';
const ENV_KEYS = ['QUEUE_BOARD_ENABLED', 'NODE_ENV'] as const;

async function startApp(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/app.setup.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

describe('Bull Board (e2e)', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  it('is not mounted by default, even outside production', async () => {
    app = await startApp({ NODE_ENV: 'development' });
    await request(app.getHttpServer()).get(BOARD_PATH).expect(404);
    await request(app.getHttpServer()).get(`${BOARD_PATH}/api/queues`).expect(404);
  });

  it('is not mounted when the flag is explicitly false', async () => {
    app = await startApp({ NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'false' });
    await request(app.getHttpServer()).get(BOARD_PATH).expect(404);
  });

  it('is mounted in development when the flag is true', async () => {
    app = await startApp({ NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'true' });
    const res = await request(app.getHttpServer()).get(BOARD_PATH).expect(200);
    expect(res.text).toContain('<html');
  });

  it('refuses to start in production with the flag on (fail fast, never silently ignored)', async () => {
    // ConfigModule validates the environment while the application is being built.
    await expect(startApp({ NODE_ENV: 'production', QUEUE_BOARD_ENABLED: 'true' })).rejects.toThrow(
      /QUEUE_BOARD_ENABLED/,
    );
  });

  it('relaxes the CSP for the board path only; every other path keeps the exact same headers', async () => {
    const strictHeaders = async (path: string) => {
      const res = await request(app!.getHttpServer()).get(path);
      return {
        csp: res.headers['content-security-policy'],
        others: Object.fromEntries(
          Object.entries(res.headers).filter(([name]) =>
            ['x-frame-options', 'x-content-type-options', 'strict-transport-security'].includes(
              name,
            ),
          ),
        ),
      };
    };
    const probes = ['/health', '/api/v1/auth/me', '/api/v1/queues-lookalike', '/nope'];

    app = await startApp({ NODE_ENV: 'development' });
    const before = await Promise.all(probes.map(strictHeaders));
    await app.close();

    app = await startApp({ NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'true' });
    const after = await Promise.all(probes.map(strictHeaders));
    const board = await request(app.getHttpServer()).get(BOARD_PATH);

    expect(after).toEqual(before);
    for (const { csp } of after) expect(csp).toContain("default-src 'self'");
    expect(board.headers['content-security-policy']).toBeUndefined();
    // The relaxation is not a bypass of helmet as a whole.
    expect(board.headers['x-content-type-options']).toBe('nosniff');
  });
});
