import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { acquireLock } from '../../src/infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { createTestPrisma, resetDatabase } from '../factories/database';
import { createOrganization, TEST_PASSWORD } from '../factories/organization.factory';
import { createTestApp } from '../setup/create-test-app';

// ADR 0016 over real HTTP: what a client actually receives (status, Retry-After, body) when the
// database fails. The classification itself is pinned against real PostgreSQL in
// test/integration/prisma-failures.integration-spec.ts; nothing is mocked here.
const API = '/api/v1';
const DEAD_DATABASE = 'postgresql://salesflow:unused@localhost:1/salesflow';
const deferred = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { released, release };
};

// Environment for one app, put back afterwards (validateEnv writes defaults into process.env).
async function withEnv<T>(env: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const login = (app: INestApplication, email = 'nobody@example.test', password = TEST_PASSWORD) =>
  request(app.getHttpServer()).post(`${API}/auth/login`).send({ email, password });

describe('Database failure responses (e2e, real HTTP)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('database unreachable: 503 DATABASE_UNAVAILABLE with Retry-After and no driver detail', async () => {
    app = await withEnv({ DATABASE_URL: DEAD_DATABASE }, async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const created = moduleRef.createNestApplication();
      configureApp(created);
      await created.init();
      return created;
    });

    const res = await login(app);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_UNAVAILABLE',
      message: 'The service is temporarily unavailable',
      path: `${API}/auth/login`,
    });
    expect(typeof res.body.requestId).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    // Neither the host, the port nor the driver's wording reaches the client.
    expect(JSON.stringify(res.body)).not.toMatch(/localhost|:1\b|prisma|reach database|ECONN/i);
  });

  it('pool exhausted: 503 DATABASE_BUSY with Retry-After, and the service recovers', async () => {
    app = await withEnv({ DB_POOL_MAX: '1', DB_POOL_ACQUIRE_TIMEOUT_MS: '300' }, () =>
      createTestApp(),
    );
    const prisma = app.get(PrismaService);
    const { released, release } = deferred();
    // The only connection of the pool is busy for as long as this transaction is open.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await released;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await login(app);

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_BUSY',
      message: 'The service is busy, please retry shortly',
      path: `${API}/auth/login`,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/timeout exceeded|pg|prisma/i);

    release();
    await holder;
    // The connection came back: the same request now reaches the database (unknown user -> 401).
    await login(app).expect(401);
  });

  describe('a request stuck behind a lock', () => {
    it('503 DATABASE_TIMEOUT without Retry-After, and the change is rolled back', async () => {
      const seed = createTestPrisma();
      try {
        app = await withEnv({ DB_STATEMENT_TIMEOUT_MS: '1000' }, () => createTestApp());
        await resetDatabase(seed);
        const org = await createOrganization(seed, 'lock-org');
        const tokens = (await login(app, org.admin.email, org.admin.password).expect(200)).body;
        const patch = (name: string) =>
          request(app!.getHttpServer())
            .patch(`${API}/organizations/current`)
            .set('Authorization', `Bearer ${tokens.accessToken}`)
            .send({ name });
        const prisma = app.get(PrismaService);
        const { released, release } = deferred();
        // Another writer of the same organization holds its advisory lock (ADR 0004).
        const holder = prisma.$transaction(async (tx) => {
          await acquireLock(tx, 'org', org.id);
          await released;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));

        const res = await patch('Renamed while locked');

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBeUndefined();
        expect(res.body).toMatchObject({
          statusCode: 503,
          code: 'DATABASE_TIMEOUT',
          message: 'The operation took too long and was cancelled; nothing was changed',
        });

        release();
        await holder;
        const row = await seed.organization.findUniqueOrThrow({ where: { id: org.id } });
        expect(row.name).not.toBe('Renamed while locked');
        // Once the lock is free the very same request succeeds.
        await patch('Renamed after').expect(200);
      } finally {
        await seed.$disconnect();
      }
    });
  });
});
