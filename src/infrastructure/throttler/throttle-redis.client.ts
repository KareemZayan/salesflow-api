import Redis from 'ioredis';
import { QueueConfig, RedisConfig } from '../../config/app.config';
import { failFastRedisOptions } from '../redis/redis-client.options';
import { THROTTLE_HIT_SCRIPT } from './throttle-hit.script';

// The few Redis operations the storage needs, so its failure handling can be tested with a fake that
// fails, stalls or answers garbage on demand (redis-throttler.storage.spec.ts) and the real client
// is exercised against a real Redis (integration spec).
export interface ThrottleRedis {
  hit(
    hitsKey: string,
    windowKey: string,
    ttlMs: number,
    limit: number,
    member: string,
  ): Promise<unknown>;
  ping(): Promise<unknown>;
  whenReady(timeoutMs: number): Promise<void>;
  evictionSettings(): Promise<{ policy: string; maxmemoryBytes: number }>;
  close(): void;
}

type ScriptedRedis = Redis & {
  throttleHit(
    hitsKey: string,
    windowKey: string,
    ttlMs: number,
    limit: number,
    member: string,
  ): Promise<unknown>;
};

// A connection of its own, on purpose: it is not the cache's connection and not BullMQ's, so a
// failure of either cannot hide a throttle outage and the other way round. It shares only the
// settings (failFastRedisOptions).
export function createThrottleRedis(
  redisConfig: RedisConfig,
  queue: Pick<QueueConfig, 'prefix'>,
): ThrottleRedis {
  const redis = new Redis(failFastRedisOptions(redisConfig, queue, 'throttle')) as ScriptedRedis;
  redis.defineCommand('throttleHit', { numberOfKeys: 2, lua: THROTTLE_HIT_SCRIPT });
  // Without a listener an 'error' event would throw inside the client. What the failures mean is
  // decided (and logged, once per outage) by the storage, from what requests experience.
  redis.on('error', () => undefined);

  return {
    hit: (hitsKey, windowKey, ttlMs, limit, member) =>
      redis.throttleHit(hitsKey, windowKey, ttlMs, limit, member),
    ping: () => redis.ping(),
    whenReady: (timeoutMs) =>
      redis.status === 'ready'
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              redis.off('ready', onReady);
              reject(new Error(`Throttle Redis not ready after ${timeoutMs} ms`));
            }, timeoutMs);
            const onReady = () => {
              clearTimeout(timer);
              resolve();
            };
            redis.once('ready', onReady);
          }),
    evictionSettings: async () => {
      const policy = (await redis.call('CONFIG', 'GET', 'maxmemory-policy')) as string[];
      const maxmemory = (await redis.call('CONFIG', 'GET', 'maxmemory')) as string[];
      return { policy: String(policy[1]), maxmemoryBytes: Number(maxmemory[1]) };
    },
    close: () => redis.disconnect(),
  };
}
