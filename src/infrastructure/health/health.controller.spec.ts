import { ConfigService } from '@nestjs/config';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { TcpHealthIndicator } from './indicators/tcp-health.indicator';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  const redis = { host: 'cache', port: 6379 };
  const prisma = {} as PrismaService;
  const tcp = { check: vi.fn().mockResolvedValue({}) };
  const prismaHealth = { pingCheck: vi.fn().mockResolvedValue({}) };
  const health = {
    check: vi.fn(async (indicators: Array<() => Promise<unknown>>) => {
      await Promise.all(indicators.map((run) => run()));
      return { status: 'ok' };
    }),
  };
  const config = { getOrThrow: () => ({ redis }) };
  const controller = new HealthController(
    health as unknown as HealthCheckService,
    prismaHealth as unknown as PrismaHealthIndicator,
    prisma,
    tcp as unknown as TcpHealthIndicator,
    config as unknown as ConfigService,
  );

  beforeEach(() => vi.clearAllMocks());

  it('liveness checks no external dependency', async () => {
    await controller.live();
    expect(health.check).toHaveBeenCalledWith([]);
    expect(tcp.check).not.toHaveBeenCalled();
    expect(prismaHealth.pingCheck).not.toHaveBeenCalled();
  });

  it('readiness pings postgres through Prisma and probes redis over TCP', async () => {
    await controller.ready();
    expect(prismaHealth.pingCheck).toHaveBeenCalledWith('postgres', prisma, expect.any(Object));
    expect(tcp.check).toHaveBeenCalledWith('redis', redis);
  });
});
