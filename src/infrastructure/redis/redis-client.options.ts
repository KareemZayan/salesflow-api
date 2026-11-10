import type { RedisOptions } from 'ioredis';
import { QueueConfig, RedisConfig } from '../../config/app.config';
import { REDIS_NAMESPACE, RedisNamespace } from './redis-namespaces';

// The one definition of "a Redis connection for something that must not wait on Redis": the cache
// and the throttle storage both use it, so host, port, password, key prefix and fail-fast behaviour
// come from the same settings (AppConfig.redis, the queue prefix) and cannot drift apart.
// BullMQ keeps its own connection through the same AppConfig.redis values (queue.module.ts).
export function failFastRedisOptions(
  redis: RedisConfig,
  queue: Pick<QueueConfig, 'prefix'>,
  namespace: RedisNamespace,
): RedisOptions {
  return {
    host: redis.host,
    port: redis.port,
    password: redis.password,
    // Same prefix as the queues (a test app or a second environment on one Redis stays apart), plus
    // a namespace no queue can have (see redis-namespaces.ts).
    keyPrefix: `${queue.prefix}:${REDIS_NAMESPACE[namespace]}:`,
    // Commands fail at once while disconnected instead of piling up behind the outage.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  };
}
