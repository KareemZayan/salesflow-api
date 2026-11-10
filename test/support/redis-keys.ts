import Redis from 'ioredis';

// Direct access to the compose Redis for tests that must look at what was really stored (and clean
// it up). Everything is scoped by a prefix the caller owns; nothing outside it is read or deleted,
// and the database is never flushed.
export function testRedis(): Redis {
  const port = process.env.TEST_REDIS_PORT;
  if (!port) throw new Error('TEST_REDIS_PORT is not set: this test needs the compose Redis');
  return new Redis({
    host: '127.0.0.1',
    port: Number(port),
    password: process.env.REDIS_PASSWORD || undefined,
  });
}

// SCAN (not KEYS) so a large database is not blocked. Returns full key names, prefix included.
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    found.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return found;
}

export async function deleteKeysWithPrefix(redis: Redis, prefix: string): Promise<void> {
  const keys = await scanKeys(redis, `${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
}
