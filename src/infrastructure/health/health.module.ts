import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { TcpHealthIndicator } from './indicators/tcp-health.indicator';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [TcpHealthIndicator],
})
export class HealthModule {}
