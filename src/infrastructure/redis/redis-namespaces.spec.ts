import { QUEUE_NAME_LIST } from '../queue/queue.constants';
import { failFastRedisOptions } from './redis-client.options';
import { REDIS_NAMESPACE } from './redis-namespaces';

const redis = { host: 'redis.internal', port: 6380, password: 's3cret' };
const queue = { prefix: 'salesflow' };

describe('Redis namespaces', () => {
  it('no queue is named like a namespace, so BullMQ keys can never collide with cache or throttle keys', () => {
    const namespaces: readonly string[] = Object.values(REDIS_NAMESPACE);
    for (const name of QUEUE_NAME_LIST) expect(namespaces).not.toContain(name);
  });

  it('every namespace is distinct', () => {
    const values = Object.values(REDIS_NAMESPACE);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('failFastRedisOptions', () => {
  it('takes host, port and password from the Redis settings and never queues commands offline', () => {
    expect(failFastRedisOptions(redis, queue, 'throttle')).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 's3cret',
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });

  it('prefixes every key with the queue prefix and the namespace', () => {
    expect(failFastRedisOptions(redis, queue, 'throttle').keyPrefix).toBe('salesflow:throttle:');
    expect(failFastRedisOptions(redis, queue, 'cache').keyPrefix).toBe('salesflow:cache:');
  });

  it('backs off between reconnects, capped at 5 s', () => {
    const { retryStrategy } = failFastRedisOptions(redis, queue, 'cache');
    expect(retryStrategy?.(1)).toBe(200);
    expect(retryStrategy?.(1000)).toBe(5000);
  });
});
