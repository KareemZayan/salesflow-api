import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { JobQueueService } from './job-queue.service';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAME_LIST } from './queue.constants';
import { QueueWorkersService } from './queue-workers.service';
import { QUEUES, QueueRegistry } from './queue.tokens';

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
  providers: [
    {
      provide: QUEUES,
      inject: QUEUE_NAME_LIST.map((name) => getQueueToken(name)),
      useFactory: (...queues: Queue[]): QueueRegistry =>
        Object.fromEntries(QUEUE_NAME_LIST.map((name, i) => [name, queues[i]])) as QueueRegistry,
    },
    JobQueueService,
    QueueWorkersService,
  ],
  exports: [JobQueueService, QueueWorkersService],
})
export class QueueModule {}
