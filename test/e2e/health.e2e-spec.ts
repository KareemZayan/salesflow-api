import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health returns ok without the API prefix', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/health is not routed (health stays outside the prefix)', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });

  it('generates a request id, and echoes a caller-supplied one', async () => {
    const generated = await request(app.getHttpServer()).get('/health').expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'trace-123')
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('trace-123');
  });

  it('GET /health/ready returns 503 when dependencies are unreachable', async () => {
    // Test env points at ports nothing listens on, so readiness must fail loudly.
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    // Probe diagnostics travel in `details` of the standard error body.
    expect(res.body).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(res.body.details).toHaveProperty('postgres');
  });
});
