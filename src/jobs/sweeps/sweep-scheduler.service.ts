import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { SweepsProcessor } from './sweeps.processor';

// Registers the repeatable sweeps (BullMQ job schedulers) on startup. Only instances that run
// workers do it, which also keeps a producer-only API instance from touching schedules. Upserting is
// idempotent, so any number of instances booting at once still leaves one schedule per sweep, and a
// changed interval here replaces the old one on the next deploy.
@Injectable()
export class SweepSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SweepSchedulerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly queue: JobQueueService,
    private readonly sweeps: SweepsProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { queue } = this.config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    if (!queue.workersEnabled) return;
    for (const sweep of this.sweeps.sweeps) {
      try {
        await this.queue.schedule(QUEUE_NAMES.SWEEPS, sweep.name, sweep.repeat, sweep.name);
      } catch (error) {
        // Redis being down at boot must not stop the API. The schedule is registered on the next
        // start; until then the due work simply waits (nothing is lost, it is all in the database).
        this.logger.error(
          `Could not schedule sweep ${sweep.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
