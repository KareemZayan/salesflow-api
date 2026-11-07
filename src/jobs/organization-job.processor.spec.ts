import { Job } from 'bullmq';
import { QUEUE_NAMES, QueueName } from '../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../infrastructure/queue/queue-workers.service';
import { OrganizationJobProcessor } from './organization-job.processor';

const register = vi.fn();
const run = vi.fn();

class TestProcessor extends OrganizationJobProcessor {
  readonly queueName: QueueName = QUEUE_NAMES.TASK_OVERDUE;
  protected run(now: Date) {
    return run(now);
  }
}
const processor = new TestProcessor({ register } as unknown as QueueWorkersService);
const job = { data: { organizationId: 'org-1' } } as Job<{ organizationId: string }>;

describe('OrganizationJobProcessor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers itself with the workers on init', () => {
    processor.onModuleInit();
    expect(register).toHaveBeenCalledWith(processor);
  });

  it('runs the work with the current time and returns its counts', async () => {
    run.mockResolvedValue({ deleted: 3 });
    await expect(processor.handle(job)).resolves.toEqual({ deleted: 3 });
    expect(run).toHaveBeenCalledWith(expect.any(Date));
  });

  it('logs the counts when something happened', async () => {
    const log = vi.spyOn(processor['logger'], 'log').mockImplementation(() => undefined);
    run.mockResolvedValue({ deleted: 3, capped: false });
    await processor.handle(job);
    expect(log).toHaveBeenCalledWith({
      event: 'task-overdue.done',
      organizationId: 'org-1',
      deleted: 3,
      capped: false,
    });
  });

  it('stays silent when nothing happened', async () => {
    const log = vi.spyOn(processor['logger'], 'log').mockImplementation(() => undefined);
    run.mockResolvedValue({ deleted: 0, capped: false });
    await processor.handle(job);
    expect(log).not.toHaveBeenCalled();
  });

  it('lets a failure reach BullMQ so it retries', async () => {
    run.mockRejectedValue(new Error('db down'));
    await expect(processor.handle(job)).rejects.toThrow('db down');
  });
});
