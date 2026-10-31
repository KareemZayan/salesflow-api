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
});
