import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisHealthIndicator } from './indicators/redis-health.indicator';

// Mounted outside the /api/v1 prefix (see main.ts) so orchestrators can probe a stable path.
export const HEALTH_ROUTE = 'health';
export const READINESS_ROUTE = `${HEALTH_ROUTE}/ready`;

const DB_CHECK_TIMEOUT_MS = 2000;

// Probes carry no token and run often, so they bypass both authentication and rate limiting.
@Public()
@SkipThrottle({ default: true, auth: true })
@Controller(HEALTH_ROUTE)
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  // Liveness: the process is up. Must not depend on external services.
  @Get()
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  // Readiness: the dependencies this instance needs are reachable.
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaHealth.pingCheck('postgres', this.prisma, { timeout: DB_CHECK_TIMEOUT_MS }),
      () => this.redis.check('redis'),
    ]);
  }
}
