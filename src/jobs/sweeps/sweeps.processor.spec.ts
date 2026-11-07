import { Job, UnrecoverableError } from 'bullmq';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { OrganizationWorkRepository } from '../bootstrap/organization-work.repository';
import { OrganizationSweep, SWEEP_PAGE_SIZE } from './organization-sweeps';
import { SweepsProcessor } from './sweeps.processor';

const enqueue = vi.fn();
const register = vi.fn();
const work = {
  withDueReminders: vi.fn(),
  withUnnotifiedOverdueTasks: vi.fn(),
  allActive: vi.fn(),
};
const processor = new SweepsProcessor(
  work as unknown as OrganizationWorkRepository,
  { enqueue } as unknown as JobQueueService,
  { register } as unknown as QueueWorkersService,
);
const sweepNamed = (name: string): OrganizationSweep => {
  const sweep = processor.sweeps.find((candidate) => candidate.name === name);
  if (!sweep) throw new Error(`no sweep ${name}`);
  return sweep;
};

const NOW = new Date('2026-11-07T10:00:30.000Z');
const MINUTE = 60_000;

describe('SweepsProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueue.mockResolvedValue(undefined);
  });

  it('registers as a cross-tenant handler of the sweeps queue', () => {
    processor.onModuleInit();
    expect(register).toHaveBeenCalledWith(processor);
    expect(processor.queueName).toBe(QUEUE_NAMES.SWEEPS);
    expect(processor.tenantScoped).toBe(false);
  });

  it('defines the four sweeps with the documented cadence', () => {
    expect(processor.sweeps.map(({ name, repeat }) => [name, repeat])).toEqual([
      ['task-reminders', { every: MINUTE }],
      ['task-overdue', { every: 15 * MINUTE }],
      ['refresh-token-cleanup', { pattern: '15 3 * * *' }],
      ['notification-retention', { pattern: '30 3 * * *' }],
    ]);
  });

  it('enqueues nothing when no organization has work (an idle tick is free)', async () => {
    work.withDueReminders.mockResolvedValue([]);
    await expect(processor.run(sweepNamed('task-reminders'), NOW)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fans out one tenant job per organization with work, with a time-bucketed job id', async () => {
    work.withDueReminders.mockResolvedValue(['org-a', 'org-b']);
    await processor.run(sweepNamed('task-reminders'), NOW);
    const bucket = Math.floor(NOW.getTime() / MINUTE);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      QUEUE_NAMES.TASK_REMINDERS,
      'task-reminders',
      { organizationId: 'org-a' },
      { jobId: `task-reminders-org-a-${bucket}` },
    );
  });

  it('two sweeps in the same bucket use the same job ids, the next bucket a new one', async () => {
    work.withDueReminders.mockResolvedValue(['org-a']);
    const sweep = sweepNamed('task-reminders');
    await processor.run(sweep, NOW);
    await processor.run(sweep, new Date(NOW.getTime() + 10_000));
    await processor.run(sweep, new Date(NOW.getTime() + MINUTE));
    const ids = enqueue.mock.calls.map(([, , , options]) => (options as { jobId: string }).jobId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('the overdue sweep uses a 15 minute bucket', async () => {
    work.withUnnotifiedOverdueTasks.mockResolvedValue(['org-a']);
    const sweep = sweepNamed('task-overdue');
    await processor.run(sweep, NOW);
    await processor.run(sweep, new Date(NOW.getTime() + 5 * MINUTE));
    const ids = enqueue.mock.calls.map(([, , , options]) => (options as { jobId: string }).jobId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('walks every page of organizations, continuing after the last id', async () => {
    const firstPage = Array.from({ length: SWEEP_PAGE_SIZE }, (_, i) => `org-${i}`);
    work.allActive.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(['org-last']);
    await processor.run(sweepNamed('notification-retention'), NOW);
    expect(work.allActive).toHaveBeenNthCalledWith(1, null, SWEEP_PAGE_SIZE);
    expect(work.allActive).toHaveBeenNthCalledWith(
      2,
      firstPage[SWEEP_PAGE_SIZE - 1],
      SWEEP_PAGE_SIZE,
    );
    expect(enqueue).toHaveBeenCalledTimes(SWEEP_PAGE_SIZE + 1);
  });

  it('keeps enqueueing the other organizations when one enqueue fails, then reports the failure', async () => {
    work.withDueReminders.mockResolvedValue(['org-a', 'org-b', 'org-c']);
    enqueue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis hiccup'))
      .mockResolvedValueOnce(undefined);
    await expect(processor.run(sweepNamed('task-reminders'), NOW)).rejects.toThrow(
      '1 organization job(s) could not be enqueued',
    );
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('logs counts only, never organization ids, and stays silent when idle', async () => {
    const log = vi.spyOn(processor['logger'], 'log').mockImplementation(() => undefined);
    work.withDueReminders.mockResolvedValueOnce([]).mockResolvedValueOnce(['org-secret']);
    await processor.run(sweepNamed('task-reminders'), NOW);
    expect(log).not.toHaveBeenCalled();
    await processor.run(sweepNamed('task-reminders'), NOW);
    expect(log).toHaveBeenCalledWith({
      event: 'sweep.done',
      sweep: 'task-reminders',
      enqueued: 1,
      failed: 0,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('org-secret');
  });

  it('handle() runs the sweep named by the job and refuses an unknown name for good', async () => {
    work.withDueReminders.mockResolvedValue([]);
    await expect(processor.handle({ name: 'task-reminders' } as Job)).resolves.toBe(0);
    await expect(processor.handle({ name: 'nope' } as Job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
