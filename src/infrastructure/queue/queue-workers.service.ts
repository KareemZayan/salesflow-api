import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { DEFAULT_WORKER_CONCURRENCY, WORKER_CLOSE_TIMEOUT_MS } from './queue.constants';
import { QueueJobHandler, TenantJobPayload } from './queue.types';

// Runs the registered handlers as BullMQ workers. Handlers register themselves in their own
// onModuleInit, workers start once every module is initialised, so this infrastructure module
// never has to import the feature modules (no dependency cycle).
//
// `QUEUE_WORKERS_ENABLED=false` makes the process producer-only (API instance without workers).
@Injectable()
export class QueueWorkersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkersService.name);
  private readonly handlers: QueueJobHandler<object>[] = [];
  private readonly workers: Worker[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantContextService,
  ) {}

  register<P extends object>(handler: QueueJobHandler<P>): void {
    this.handlers.push(handler);
  }

  onApplicationBootstrap(): void {
    const { redis, queue } = this.config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    if (!queue.workersEnabled) return;
    for (const handler of this.handlers) {
      const worker = new Worker(handler.queueName, (job) => this.run(handler, job), {
        connection: redis,
        prefix: queue.prefix,
        concurrency: handler.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      });
      worker.on('error', (error) =>
        this.logger.error(`Worker ${handler.queueName} error: ${error.message}`),
      );
      // Ids and the error class only: a payload can hold personal data, and some driver error
      // messages echo query values. The full reason stays on the failed job in Redis.
      worker.on('failed', (job, error) => {
        const attempts = job?.opts.attempts ?? 1;
        // An UnrecoverableError is never retried, whatever attempts are left.
        const final =
          error instanceof UnrecoverableError ||
          (job !== undefined && job.attemptsMade >= attempts);
        this.logger.error(
          `Job ${handler.queueName}/${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'}` +
            `/${attempts}${final ? ', giving up' : ', will retry'}): ${error.name}`,
        );
      });
      this.workers.push(worker);
    }
  }

  // A worker has no request, so the tenant context comes from the payload. A job without a tenant
  // can never succeed, so it is not retried. Only a handler that declares itself cross-tenant
  // (`tenantScoped: false`, the sweeps) runs without one.
  private run(handler: QueueJobHandler<object>, job: Job<object>): Promise<unknown> {
    if (handler.tenantScoped === false) return handler.handle(job);
    const organizationId: unknown = (job.data as Partial<TenantJobPayload> | undefined)
      ?.organizationId;
    if (typeof organizationId !== 'string' || organizationId === '') {
      throw new UnrecoverableError('Job payload has no organizationId');
    }
    return this.tenant.run(organizationId, () => handler.handle(job));
  }

  // Lets running jobs finish, but only for WORKER_CLOSE_TIMEOUT_MS: with Redis down a graceful close
  // would wait forever. A job cut off by the forced close is re-delivered by BullMQ (stalled-job
  // recovery), which is safe because every handler is idempotent.
  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.workers.map(async (worker) => {
        try {
          await withTimeout(worker.close(), WORKER_CLOSE_TIMEOUT_MS, 'Worker close');
        } catch {
          await worker.close(true);
        }
      }),
    );
    this.workers.length = 0;
  }
}
