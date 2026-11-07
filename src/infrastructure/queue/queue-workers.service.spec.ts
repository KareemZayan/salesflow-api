import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { QUEUE_NAMES, WORKER_CLOSE_TIMEOUT_MS } from './queue.constants';
import { QueueWorkersService } from './queue-workers.service';
import { QueueJobHandler } from './queue.types';

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: vi.fn(),
}));

type Processor = (job: Job) => Promise<unknown>;
interface FakeWorker {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const redis = { host: 'cache', port: 6379 };
const configFor = (workersEnabled: boolean) =>
  ({
    getOrThrow: () => ({ redis, queue: { prefix: 'p', workersEnabled } }),
  }) as unknown as ConfigService;
const run = vi.fn((_org: string, fn: () => Promise<unknown>) => fn());
const tenant = { run } as unknown as TenantContextService;
const handle = vi.fn();
const handler: QueueJobHandler = { queueName: QUEUE_NAMES.NOTIFICATIONS, handle };

let created: FakeWorker[];
let processors: Processor[];

function started(workersEnabled = true): QueueWorkersService {
  const service = new QueueWorkersService(configFor(workersEnabled), tenant);
  service.register(handler);
  service.onApplicationBootstrap();
  return service;
}

describe('QueueWorkersService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    created = [];
    processors = [];
    vi.mocked(Worker).mockImplementation(function (_name: string, processor: unknown) {
      const fake: FakeWorker = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      created.push(fake);
      processors.push(processor as Processor);
      return fake as unknown as Worker;
    } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('starts nothing when workers are disabled (producer-only instance)', () => {
    started(false);
    expect(Worker).not.toHaveBeenCalled();
  });

  it('starts one worker per registered handler on its queue, prefix and connection', () => {
    started();
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(Worker).toHaveBeenCalledWith(
      QUEUE_NAMES.NOTIFICATIONS,
      expect.any(Function),
      expect.objectContaining({ connection: redis, prefix: 'p', concurrency: 5 }),
    );
  });

  it('runs the handler inside the tenant named in the payload', async () => {
    started();
    handle.mockResolvedValue('done');
    const job = { data: { organizationId: 'org-1' } } as Job;
    await expect(processors[0](job)).resolves.toBe('done');
    expect(run).toHaveBeenCalledWith('org-1', expect.any(Function));
    expect(handle).toHaveBeenCalledWith(job);
  });

  it('runs a cross-tenant handler without a tenant, and without requiring an organizationId', async () => {
    const sweepHandle = vi.fn().mockResolvedValue('swept');
    const service = new QueueWorkersService(configFor(true), tenant);
    service.register({ queueName: QUEUE_NAMES.SWEEPS, tenantScoped: false, handle: sweepHandle });
    service.onApplicationBootstrap();
    const job = { data: {} } as Job;
    await expect(processors[0](job)).resolves.toBe('swept');
    expect(run).not.toHaveBeenCalled();
    expect(sweepHandle).toHaveBeenCalledWith(job);
  });

  it.each([{}, { organizationId: '' }, { organizationId: 7 }, undefined])(
    'fails a job without a usable tenant for good, without calling the handler (%j)',
    (data) => {
      started();
      expect(() => processors[0]({ data } as Job)).toThrow(UnrecoverableError);
      expect(handle).not.toHaveBeenCalled();
    },
  );

  it('lets a handler error reach BullMQ so it can retry', async () => {
    started();
    handle.mockRejectedValue(new Error('db down'));
    await expect(processors[0]({ data: { organizationId: 'o' } } as Job)).rejects.toThrow(
      'db down',
    );
  });

  it('logs a failed attempt with ids and the error class only', () => {
    const log = vi.spyOn(started()['logger'], 'error').mockImplementation(() => undefined);
    const failed = created[0].on.mock.calls.find(([event]) => event === 'failed')?.[1] as (
      job: unknown,
      error: Error,
    ) => void;
    const secret = new Error('value for jane@example.com');
    failed({ id: 'j1', attemptsMade: 2, opts: { attempts: 5 } }, secret);
    failed({ id: 'j1', attemptsMade: 5, opts: { attempts: 5 } }, secret);
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages[0]).toContain('attempt 2/5, will retry');
    expect(messages[1]).toContain('giving up');
    expect(messages.join(' ')).not.toContain('jane@example.com');

    failed(
      { id: 'j2', attemptsMade: 1, opts: { attempts: 5 } },
      new UnrecoverableError('no tenant'),
    );
    expect(String(log.mock.calls[2][0])).toContain('giving up');
  });

  it('closes its workers on shutdown', async () => {
    const service = started();
    await service.onModuleDestroy();
    expect(created[0].close).toHaveBeenCalledWith();
  });

  it('forces the close when running jobs do not finish in time (Redis down)', async () => {
    vi.useFakeTimers();
    const service = started();
    created[0].close.mockImplementationOnce(() => new Promise(() => undefined));
    const closing = service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(WORKER_CLOSE_TIMEOUT_MS);
    await closing;
    expect(created[0].close).toHaveBeenLastCalledWith(true);
  });
});
