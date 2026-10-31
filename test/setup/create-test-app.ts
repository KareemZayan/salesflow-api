import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { ProbeController } from '../support/probe.controller';
import { assertTestDatabase } from './test-database';

// The full production wiring (configureApp) on top of the real test database. The e2e config points
// DATABASE_URL at a dead port by default so suites that need no data stay hermetic; suites that do
// need data call this instead, which swaps in the dedicated `_test` database.
export async function createTestApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
