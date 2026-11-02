import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { JobQueueService } from './job-queue.service';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAME_LIST } from './queue.constants';
import { QueueWorkersService } from './queue-workers.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { redis, queue } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
        return { connection: redis, prefix: queue.prefix };
      },
    }),
    BullModule.registerQueue(
      ...QUEUE_NAME_LIST.map((name) => ({ name, defaultJobOptions: DEFAULT_JOB_OPTIONS })),
    ),
  ],
  providers: [JobQueueService, QueueWorkersService],
  exports: [JobQueueService, QueueWorkersService],
})
export class QueueModule {}
