import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FAIL_CLOSED_THROTTLERS, LOGIN_THROTTLER } from '../../common/constants/throttle.constants';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { createThrottleRedis } from './throttle-redis.client';

export const REDIS_THROTTLER_STORAGE = Symbol('REDIS_THROTTLER_STORAGE');

// `null` when THROTTLE_STORAGE=memory: no connection is opened at all, so the dev / e2e default
// (an unreachable Redis) stays silent. In every other case the storage owns its own connection.
@Module({
  providers: [
    {
      provide: REDIS_THROTTLER_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RedisThrottlerStorage | null => {
        const { throttle, redis, queue } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
        if (throttle.storage !== 'redis') return null;
        return new RedisThrottlerStorage(createThrottleRedis(redis, queue), {
          failClosedThrottlers: FAIL_CLOSED_THROTTLERS,
          compositeThrottlers: new Map([[LOGIN_THROTTLER, { ipLimit: throttle.authIpLimit }]]),
        });
      },
    },
  ],
  exports: [REDIS_THROTTLER_STORAGE],
})
export class ThrottlerStorageModule {}
