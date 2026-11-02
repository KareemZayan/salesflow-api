import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './indicators/redis-health.indicator';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  const prisma = {} as PrismaService;
  const redis = { check: vi.fn().mockResolvedValue({}) };
  const prismaHealth = { pingCheck: vi.fn().mockResolvedValue({}) };
  const health = {
    check: vi.fn(async (indicators: Array<() => Promise<unknown>>) => {
      await Promise.all(indicators.map((run) => run()));
      return { status: 'ok' };
    }),
  };
  const controller = new HealthController(
    health as unknown as HealthCheckService,
    prismaHealth as unknown as PrismaHealthIndicator,
    prisma,
    redis as unknown as RedisHealthIndicator,
  );

  beforeEach(() => vi.clearAllMocks());

  it('liveness checks no external dependency', async () => {
    await controller.live();
    expect(health.check).toHaveBeenCalledWith([]);
    expect(redis.check).not.toHaveBeenCalled();
    expect(prismaHealth.pingCheck).not.toHaveBeenCalled();
  });

  it('readiness pings postgres through Prisma and pings redis through the queue connection', async () => {
    await controller.ready();
    expect(prismaHealth.pingCheck).toHaveBeenCalledWith('postgres', prisma, expect.any(Object));
    expect(redis.check).toHaveBeenCalledWith('redis');
  });
});
