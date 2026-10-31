import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { TcpHealthIndicator } from './indicators/tcp-health.indicator';

// Mounted outside the /api/v1 prefix (see main.ts) so orchestrators can probe a stable path.
export const HEALTH_ROUTE = 'health';
export const READINESS_ROUTE = `${HEALTH_ROUTE}/ready`;

const DB_CHECK_TIMEOUT_MS = 2000;

@Controller(HEALTH_ROUTE)
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly tcp: TcpHealthIndicator,
    private readonly configService: ConfigService,
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
    const { redis } = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    return this.health.check([
      () => this.prismaHealth.pingCheck('postgres', this.prisma, { timeout: DB_CHECK_TIMEOUT_MS }),
      () => this.tcp.check('redis', redis),
    ]);
  }
}
