import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { APP_CONFIG_KEY, AppConfig } from '../config/app.config';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';
import { authThrottleTracker, isAuthThrottled } from './guards/throttle.util';
import {
  HTTP_REQUEST_KEY,
  RequestLike,
  RequestMetadataService,
} from './request-context/request-metadata.service';
import { TenantContextService } from './tenant/tenant-context.service';

export const AUTH_THROTTLER = 'auth';

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        // The request itself, read lazily by RequestMetadataService (audit trail: ip, user agent,
        // request id).
        setup: (cls, req: RequestLike) => cls.set(HTTP_REQUEST_KEY, req),
      },
    }),
    // In-memory counters: fine for one instance, reset on restart. Move the storage to Redis
    // (@nest-lab/throttler-storage-redis) before running more than one API instance.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { throttle } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
        return {
          throttlers: [
            {
              name: 'default',
              ttl: throttle.ttlMs,
              limit: throttle.limit,
              skipIf: isAuthThrottled,
            },
            {
              name: AUTH_THROTTLER,
              ttl: throttle.ttlMs,
              limit: throttle.authLimit,
              skipIf: (context) => !isAuthThrottled(context),
              getTracker: authThrottleTracker,
            },
          ],
        };
      },
    }),
  ],
  providers: [
    TenantContextService,
    RequestMetadataService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: throttle first (cheap, protects the rest), then identity, then
    // "must change password", then role and permission checks that need the identity.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PasswordChangeRequiredGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [TenantContextService, RequestMetadataService],
})
export class CommonModule {}
