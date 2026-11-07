import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { DynamicModule, Logger, Module, OnModuleInit } from '@nestjs/common';
import { isQueueBoardEnabled } from '../../config/queue-board';
import { QUEUE_BOARD_ROUTE, QUEUE_NAME_LIST } from './queue.constants';
import { QueueModule } from './queue.module';

// Bull Board: a UI to look at queues, failed jobs and retry them. Mounted as Express middleware, so
// the Nest guards do NOT protect it: it is development-only and closed by default (see
// isQueueBoardEnabled). It lists the very queues QueueModule registers, from the same name list.
//
// Its packages are regular dependencies on purpose: this module is imported statically by AppModule,
// so the production image (`pnpm install --prod`) must be able to load it even though it never mounts.
@Module({})
export class QueueBoardModule implements OnModuleInit {
  private readonly logger = new Logger(QueueBoardModule.name);

  static register(): DynamicModule {
    if (!isQueueBoardEnabled()) return { module: QueueBoardModule };
    return {
      module: QueueBoardModule,
      imports: [
        QueueModule,
        BullBoardModule.forRoot({ route: QUEUE_BOARD_ROUTE, adapter: ExpressAdapter }),
        BullBoardModule.forFeature(
          ...QUEUE_NAME_LIST.map((name) => ({ name, adapter: BullMQAdapter })),
        ),
      ],
    };
  }

  onModuleInit(): void {
    if (isQueueBoardEnabled()) {
      this.logger.warn(
        `Bull Board is ON at ${QUEUE_BOARD_ROUTE} (under the API prefix). It has no authentication: local development only.`,
      );
    }
  }
}
