import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { ActivitiesService } from '../../modules/activities/activities.service';
import { CreateActivityJob } from '../../modules/activities/activity-job';
import { ActivitiesProcessor } from './activities.processor';

const createFromJob = vi.fn();
const register = vi.fn();
const processor = new ActivitiesProcessor(
  { createFromJob } as unknown as ActivitiesService,
  { register } as unknown as QueueWorkersService,
);
const data = {
  dedupeKey: 'lead.assigned-l-1-lead-l',
  subject: 'secret subject',
} as CreateActivityJob;
const job = { data } as Job<CreateActivityJob>;

beforeEach(() => vi.clearAllMocks());

describe('ActivitiesProcessor', () => {
  it('registers itself for the activities queue', () => {
    processor.onModuleInit();
    expect(register).toHaveBeenCalledWith(processor);
    expect(processor.queueName).toBe(QUEUE_NAMES.ACTIVITIES);
  });

  it('writes through the service and returns its outcome', async () => {
    createFromJob.mockResolvedValue('created');
    expect(await processor.handle(job)).toBe('created');
    expect(createFromJob).toHaveBeenCalledWith(data);
  });

  it('a redelivered job completes as a duplicate', async () => {
    createFromJob.mockResolvedValue('duplicate');
    expect(await processor.handle(job)).toBe('duplicate');
  });

  it('a missing target completes as skipped and the log names the key, not the content', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    createFromJob.mockResolvedValue('unknownTarget');
    expect(await processor.handle(job)).toBe('unknownTarget');
    expect(String(warn.mock.calls[0][0])).toContain(data.dedupeKey);
    expect(String(warn.mock.calls[0][0])).not.toContain('secret subject');
  });

  it('a database error propagates so BullMQ retries', async () => {
    createFromJob.mockRejectedValue(new Error('db down'));
    await expect(processor.handle(job)).rejects.toThrow('db down');
  });
});
