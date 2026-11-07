import { NotificationType } from '../../generated/prisma/client';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { CREATE_NOTIFICATION_JOB, CreateNotificationJob } from './notification-job';

const job: CreateNotificationJob = {
  organizationId: 'org',
  userId: 'rep',
  type: NotificationType.TASK_ASSIGNED,
  title: 'secret title',
  body: null,
  data: { taskId: 't' },
  dedupeKey: 'task.assigned-t-1',
};
const enqueue = vi.fn();
const dispatcher = new NotificationDispatcher({ enqueue } as unknown as JobQueueService);

describe('NotificationDispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues the job with the dedupe key as the job id', async () => {
    enqueue.mockResolvedValue(undefined);
    await dispatcher.dispatch(job);
    expect(enqueue).toHaveBeenCalledWith(QUEUE_NAMES.NOTIFICATIONS, CREATE_NOTIFICATION_JOB, job, {
      jobId: 'task.assigned-t-1',
    });
  });

  it('does nothing for a null job (nobody to notify)', async () => {
    await dispatcher.dispatch(null);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('swallows an enqueue failure: the business write already committed', async () => {
    vi.spyOn(dispatcher['logger'], 'error').mockImplementation(() => undefined);
    enqueue.mockRejectedValue(new Error('Redis down'));
    await expect(dispatcher.dispatch(job)).resolves.toBeUndefined();
  });

  it('dispatchStrict lets an enqueue failure reach the caller (a scheduled job must retry)', async () => {
    enqueue.mockRejectedValue(new Error('Redis down'));
    await expect(dispatcher.dispatchStrict(job)).rejects.toThrow('Redis down');
  });

  it('dispatchStrict uses the same job id as dispatch', async () => {
    enqueue.mockResolvedValue(undefined);
    await dispatcher.dispatchStrict(job);
    expect(enqueue).toHaveBeenCalledWith(QUEUE_NAMES.NOTIFICATIONS, CREATE_NOTIFICATION_JOB, job, {
      jobId: 'task.assigned-t-1',
    });
  });

  it('logs the failure with the key but never the notification content', async () => {
    const logger = vi.spyOn(dispatcher['logger'], 'error').mockImplementation(() => undefined);
    enqueue.mockRejectedValue(new Error('Redis down'));
    await dispatcher.dispatch(job);
    const message = String(logger.mock.calls[0][0]);
    expect(message).toContain('task.assigned-t-1');
    expect(message).not.toContain('secret title');
  });
});
