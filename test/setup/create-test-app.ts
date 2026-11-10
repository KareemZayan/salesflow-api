import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { VisibilityModule } from '../../src/common/visibility/visibility.module';
import { QUEUE_NAME_LIST } from '../../src/infrastructure/queue/queue.constants';
import { ProbeController } from '../support/probe.controller';
import { assertTestDatabase } from './test-database';

export interface TestAppOptions {
  // Connect the queues to the real compose Redis (TEST_REDIS_PORT) under a prefix that belongs to
  // this app alone. Without it the e2e default applies: an unreachable Redis, no workers.
  queue?: { workers: boolean };
  // Run the rate limiter on Redis (THROTTLE_STORAGE=redis) instead of the e2e default, in memory.
  // Uses the compose Redis like `queue`; `redisPort` points the app somewhere else (a proxy that can
  // stall, or a dead port), and `prefix` lets two apps share one set of counters, as two instances do.
  throttle?: { redisPort?: number; prefix?: string };
}

const QUEUE_ENV_KEYS = [
  'REDIS_PORT',
  'QUEUE_PREFIX',
  'QUEUE_WORKERS_ENABLED',
  'THROTTLE_STORAGE',
] as const;

// The full production wiring (configureApp) on top of the real test database. The e2e config points
// DATABASE_URL at a dead port by default so suites that need no data stay hermetic; suites that do
// need data call this instead, which swaps in the dedicated `_test` database.
export async function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);
  const saved = Object.fromEntries(QUEUE_ENV_KEYS.map((key) => [key, process.env[key]]));
  if (options.queue) useTestRedis(options.queue.workers);
  if (options.throttle) useThrottleRedis(options.throttle, !options.queue);
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, VisibilityModule],
      controllers: [ProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
  } finally {
    // The configuration was read while the app initialised; do not leak it into later suites.
    for (const key of QUEUE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function useTestRedis(workers: boolean): void {
  const port = process.env.TEST_REDIS_PORT;
  if (!port) {
    throw new Error('TEST_REDIS_PORT is not set: queue e2e tests need the compose Redis port');
  }
  process.env.REDIS_PORT = port;
  // A prefix per app: its queues cannot see development queues or another suite.
  process.env.QUEUE_PREFIX = `salesflow-test-${randomUUID().slice(0, 8)}`;
  process.env.QUEUE_WORKERS_ENABLED = String(workers);
}

function useThrottleRedis(
  throttle: NonNullable<TestAppOptions['throttle']>,
  needsTestRedis: boolean,
): void {
  if (needsTestRedis) useTestRedis(false);
  process.env.THROTTLE_STORAGE = 'redis';
  if (throttle.redisPort !== undefined) process.env.REDIS_PORT = String(throttle.redisPort);
  if (throttle.prefix !== undefined) process.env.QUEUE_PREFIX = throttle.prefix;
}

// Removes every key of this app's queues (they live under its own unique prefix; nothing outside it
// is touched, and the rest of Redis is never flushed). Call before app.close().
export async function purgeTestQueues(app: INestApplication): Promise<void> {
  for (const name of QUEUE_NAME_LIST) {
    await app.get<Queue>(getQueueToken(name), { strict: false }).obliterate({ force: true });
  }
}
