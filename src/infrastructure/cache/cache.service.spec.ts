import { CacheService } from './cache.service';

// A port nothing listens on: every Redis command fails, and the cache must still answer.
const config = {
  getOrThrow: () => ({
    redis: { host: '127.0.0.1', port: 1, password: undefined },
    queue: { prefix: 'cache-spec' },
  }),
};

describe('CacheService with Redis down', () => {
  let cache: CacheService;

  beforeEach(async () => {
    cache = new CacheService(config as never);
    await cache.onModuleInit();
  });

  afterEach(() => cache.onModuleDestroy());

  it('computes and returns the value instead of failing', async () => {
    const compute = vi.fn().mockResolvedValue({ answer: 42 });
    await expect(cache.remember('k', 60, compute)).resolves.toEqual({ answer: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes every time while it is down (nothing is remembered)', async () => {
    const compute = vi.fn().mockResolvedValue('v');
    await cache.remember('k', 60, compute);
    await cache.remember('k', 60, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('still surfaces an error of the computation itself', async () => {
    await expect(
      cache.remember('k', 60, () => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
  });
});
