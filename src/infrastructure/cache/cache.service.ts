import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { CACHE_OPERATION_TIMEOUT_MS } from './cache.constants';

// Pattern: Cache-Aside over Redis. A cache is an optimisation, never a dependency: every failure
// (Redis down, slow, a corrupt value) is logged and answered by computing the value, so a caching
// problem can never fail a request that the database could serve.
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private outage = false;

  constructor(config: ConfigService) {
    const { redis, queue } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    this.redis = new Redis({
      host: redis.host,
      port: redis.port,
      password: redis.password,
      // Same prefix as the queues: a test app or a second environment on one Redis stays apart.
      keyPrefix: `${queue.prefix}:cache:`,
      // Commands fail at once while disconnected instead of piling up behind the outage.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
    // Without a listener an 'error' event would throw inside the client. One line per outage, not
    // one per reconnect attempt.
    this.redis.on('error', (error) => {
      if (this.outage) return;
      this.outage = true;
      this.logger.warn(`Cache unavailable: ${error.message || error.name}`);
    });
    this.redis.on('ready', () => {
      if (this.outage) this.logger.log('Cache available again');
      this.outage = false;
    });
  }

  // Give the first requests a connected client; a dead Redis only delays boot by the timeout.
  async onModuleInit(): Promise<void> {
    if (this.redis.status !== 'wait' && this.redis.status !== 'ready') {
      await this.untilReady();
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  // Returns the cached JSON value or computes, stores and returns it. `compute` must return plain
  // JSON data (strings, numbers, arrays, objects): that is what a hit gives back, so both paths
  // have the same shape.
  async remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const hit = await this.read<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    await this.write(key, ttlSeconds, value);
    return value;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    // Known outage: skip Redis (and the log line) until the client reports ready again.
    if (this.outage) return undefined;
    try {
      const raw = await withTimeout(this.redis.get(key), CACHE_OPERATION_TIMEOUT_MS, 'Cache read');
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (error) {
      // The key names an organization and a report; the log carries neither it nor the value.
      this.logger.warn(`Cache read skipped: ${errorText(error)}`);
      return undefined;
    }
  }

  private async write(key: string, ttlSeconds: number, value: unknown): Promise<void> {
    if (this.outage) return;
    try {
      await withTimeout(
        this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds),
        CACHE_OPERATION_TIMEOUT_MS,
        'Cache write',
      );
    } catch (error) {
      this.logger.warn(`Cache write skipped: ${errorText(error)}`);
    }
  }

  private async untilReady(): Promise<void> {
    try {
      await withTimeout(
        new Promise<void>((resolve) => this.redis.once('ready', resolve)),
        CACHE_OPERATION_TIMEOUT_MS,
        'Cache connect',
      );
    } catch {
      // The 'error' listener already logged it; requests compute without the cache until it is back.
    }
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : 'unknown error';
