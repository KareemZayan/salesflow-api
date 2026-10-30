import { ConfigService } from '@nestjs/config';
import { HealthCheckService } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { TcpHealthIndicator } from './indicators/tcp-health.indicator';

describe('HealthController', () => {
  const postgres = { host: 'db', port: 5432 };
  const redis = { host: 'cache', port: 6379 };
  const tcp = { check: vi.fn().mockResolvedValue({}) };
  const health = {
    check: vi.fn(async (indicators: Array<() => Promise<unknown>>) => {
      await Promise.all(indicators.map((run) => run()));
      return { status: 'ok' };
    }),
  };
  const config = { getOrThrow: () => ({ postgres, redis }) };
  const controller = new HealthController(
    health as unknown as HealthCheckService,
    tcp as unknown as TcpHealthIndicator,
    config as unknown as ConfigService,
  );

  beforeEach(() => vi.clearAllMocks());

  it('liveness checks no external dependency', async () => {
    await controller.live();
    expect(health.check).toHaveBeenCalledWith([]);
    expect(tcp.check).not.toHaveBeenCalled();
  });

  it('readiness probes postgres and redis with configured endpoints', async () => {
    await controller.ready();
    expect(tcp.check).toHaveBeenCalledWith('postgres', postgres);
    expect(tcp.check).toHaveBeenCalledWith('redis', redis);
  });
});
