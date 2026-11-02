import { HealthIndicatorService } from '@nestjs/terminus';
import { JobQueueService } from '../../queue/job-queue.service';
import { RedisHealthIndicator } from './redis-health.indicator';

describe('RedisHealthIndicator', () => {
  const ping = vi.fn();
  const indicator = new RedisHealthIndicator(new HealthIndicatorService(), {
    ping,
  } as unknown as JobQueueService);

  it('reports up when Redis answers the ping', async () => {
    ping.mockResolvedValueOnce(undefined);
    const result = await indicator.check('redis');
    expect(result.redis.status).toBe('up');
  });

  it('reports down without leaking the client error', async () => {
    ping.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
    const result = await indicator.check('redis');
    expect(result.redis).toEqual({ status: 'down', message: 'unreachable' });
  });
});
