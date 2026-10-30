import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { TcpHealthIndicator } from './indicators/tcp-health.indicator';

// Mounted outside the /api/v1 prefix (see main.ts) so orchestrators can probe a stable path.
export const HEALTH_ROUTE = 'health';
export const READINESS_ROUTE = `${HEALTH_ROUTE}/ready`;

@Controller(HEALTH_ROUTE)
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
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
    const { postgres, redis } = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    return this.health.check([
      () => this.tcp.check('postgres', postgres),
      () => this.tcp.check('redis', redis),
    ]);
  }
}
