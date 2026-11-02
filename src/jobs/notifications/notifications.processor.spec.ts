import { Job } from 'bullmq';
import { NotificationType } from '../../generated/prisma/client';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { QueueWorkersService } from '../../infrastructure/queue/queue-workers.service';
import { CreateNotificationJob } from '../../modules/notifications/notification-job';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { NotificationsProcessor } from './notifications.processor';

const createFromJob = vi.fn();
const register = vi.fn();
const processor = new NotificationsProcessor(
  { createFromJob } as unknown as NotificationsService,
  { register } as unknown as QueueWorkersService,
);
const data: CreateNotificationJob = {
  organizationId: 'org',
  userId: 'rep',
  type: NotificationType.TASK_ASSIGNED,
  title: 'T',
  body: null,
  data: {},
  dedupeKey: 'k',
};
const job = { data } as Job<CreateNotificationJob>;

describe('NotificationsProcessor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers itself on the notifications queue', () => {
    processor.onModuleInit();
    expect(register).toHaveBeenCalledWith(processor);
    expect(processor.queueName).toBe(QUEUE_NAMES.NOTIFICATIONS);
  });

  it.each(['created', 'duplicate'] as const)('completes with %s', async (outcome) => {
    createFromJob.mockResolvedValue(outcome);
    await expect(processor.handle(job)).resolves.toBe(outcome);
    expect(createFromJob).toHaveBeenCalledWith(data);
  });

  it('completes (no retry) when the recipient does not exist, and warns', async () => {
    const warn = vi.spyOn(processor['logger'], 'warn').mockImplementation(() => undefined);
    createFromJob.mockResolvedValue('unknownRecipient');
    await expect(processor.handle(job)).resolves.toBe('unknownRecipient');
    expect(warn).toHaveBeenCalled();
  });

  it('lets a database failure propagate so BullMQ retries the job', async () => {
    createFromJob.mockRejectedValue(new Error('connection lost'));
    await expect(processor.handle(job)).rejects.toThrow('connection lost');
  });
});
