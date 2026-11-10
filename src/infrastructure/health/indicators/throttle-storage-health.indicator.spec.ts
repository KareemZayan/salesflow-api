import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisThrottlerStorage } from '../../throttler/redis-throttler.storage';
import { ThrottleStorageHealthIndicator } from './throttle-storage-health.indicator';

const session = {
  up: vi.fn((data?: object) => ({ throttle: { status: 'up', ...data } })),
  down: vi.fn((data?: object) => ({ throttle: { status: 'down', ...data } })),
};
const service = { check: vi.fn(() => session) } as unknown as HealthIndicatorService;
const storageWith = (probe: () => Promise<boolean>) =>
  ({ probe: vi.fn(probe) }) as unknown as RedisThrottlerStorage;

describe('ThrottleStorageHealthIndicator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is up, and says so, when the limiter is in memory (nothing to check)', async () => {
    const result = await new ThrottleStorageHealthIndicator(service, null).check('throttle');

    expect(result).toEqual({ throttle: { status: 'up', storage: 'memory' } });
  });

  it('is up when the throttle storage answers its own probe', async () => {
    const storage = storageWith(async () => true);

    const result = await new ThrottleStorageHealthIndicator(service, storage).check('throttle');

    expect(result).toEqual({ throttle: { status: 'up', storage: 'redis' } });
    expect(storage.probe).toHaveBeenCalledTimes(1);
  });

  it('is down when the throttle storage does not answer, and echoes no client error', async () => {
    const storage = storageWith(async () => false);

    const result = await new ThrottleStorageHealthIndicator(service, storage).check('throttle');

    expect(result).toEqual({
      throttle: { status: 'down', storage: 'redis', reason: 'unreachable' },
    });
  });
});
