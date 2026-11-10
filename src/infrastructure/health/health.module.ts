import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { QueueModule } from '../queue/queue.module';
import { ThrottlerStorageModule } from '../throttler/throttler-storage.module';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './indicators/redis-health.indicator';
import { ThrottleStorageHealthIndicator } from './indicators/throttle-storage-health.indicator';

@Module({
  imports: [TerminusModule, QueueModule, ThrottlerStorageModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, ThrottleStorageHealthIndicator],
})
export class HealthModule {}
