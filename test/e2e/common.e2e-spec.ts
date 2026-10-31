import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp, SWAGGER_PATH } from '../../src/app.setup';

describe('Common layer (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(() => app.close());

  it('unknown routes use the standard error shape, correlated by request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('x-request-id', 'trace-404')
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      code: 'RESOURCE_NOT_FOUND',
      path: '/api/v1/nope',
      requestId: 'trace-404',
    });
    expect(res.body.message).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it('serves the OpenAPI document outside production', async () => {
    const res = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);
    expect(res.body.info.title).toBe('SalesFlow CRM API');
  });

  it('sets helmet security headers, with a strict CSP outside the docs', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('relaxes the CSP for the Swagger docs path only', async () => {
    const docs = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

    expect(docs.headers['content-security-policy']).toBeUndefined();
    expect(docs.headers['x-content-type-options']).toBe('nosniff');
  });

  it('documents the auth routes in the OpenAPI spec', async () => {
    const res = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/auth/me',
        '/api/v1/auth/change-password',
      ]),
    );
  });
});
