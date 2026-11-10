import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { APP_CONFIG_KEY, AppConfig } from '../config/app.config';
import { RedisThrottlerStorage } from '../infrastructure/throttler/redis-throttler.storage';
import {
  REDIS_THROTTLER_STORAGE,
  ThrottlerStorageModule,
} from '../infrastructure/throttler/throttler-storage.module';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';
import {
  HTTP_REQUEST_KEY,
  RequestLike,
  RequestMetadataService,
} from './request-context/request-metadata.service';
import { TenantContextService } from './tenant/tenant-context.service';
import { buildThrottlerOptions } from './throttler.options';

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
    // Counters live in Redis (shared by every instance) unless THROTTLE_STORAGE=memory, which is for
    // development and tests only and is refused in production. What happens when Redis cannot be
    // consulted: ADR 0016, section 15c.
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [ConfigService, REDIS_THROTTLER_STORAGE],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage | null) =>
        buildThrottlerOptions(config.getOrThrow<AppConfig>(APP_CONFIG_KEY).throttle, storage),
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
