import { NotificationType } from '../../generated/prisma/client';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { TaskAlertsService } from './task-alerts.service';
import { TasksRepository } from './tasks.repository';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const repository = {
  findDueReminders: vi.fn(),
  markReminderSent: vi.fn(),
  findOverdueUnnotified: vi.fn(),
  markOverdueNotified: vi.fn(),
};
const dispatchStrict = vi.fn();
const service = new TaskAlertsService(
  repository as unknown as TasksRepository,
  { dispatchStrict } as unknown as NotificationDispatcher,
);

const reminder = (id: string) => ({
  id,
  organizationId: 'org',
  assigneeId: 'rep',
  reminderAt: new Date('2026-11-07T09:00:00.000Z'),
});
const overdue = (id: string) => ({
  id,
  organizationId: 'org',
  assigneeId: 'rep',
  dueDate: new Date('2026-11-06T09:00:00.000Z'),
});

describe('TaskAlertsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchStrict.mockResolvedValue(undefined);
  });

  describe('sendDueReminders', () => {
    it('enqueues a TASK_DUE_SOON for the assignee and then marks the reminder', async () => {
      const task = reminder('t1');
      repository.findDueReminders.mockResolvedValue([task]);
      repository.markReminderSent.mockResolvedValue(true);

      const run = await service.sendDueReminders(NOW);

      expect(dispatchStrict).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'rep', type: NotificationType.TASK_DUE_SOON }),
      );
      expect(repository.markReminderSent).toHaveBeenCalledWith(task, NOW);
      expect(run).toEqual({ notified: 1, superseded: 0, capped: false });
      // Enqueue first, marker second: a crash in between repeats the (deduplicated) enqueue
      // instead of losing the notification.
      expect(dispatchStrict.mock.invocationCallOrder[0]).toBeLessThan(
        repository.markReminderSent.mock.invocationCallOrder[0],
      );
    });

    it('counts a reminder that was rescheduled meanwhile as superseded, not as sent', async () => {
      repository.findDueReminders.mockResolvedValue([reminder('t1')]);
      repository.markReminderSent.mockResolvedValue(false);
      await expect(service.sendDueReminders(NOW)).resolves.toEqual({
        notified: 0,
        superseded: 1,
        capped: false,
      });
    });

    it('does not mark anything when the queue is down, and the error reaches the job', async () => {
      repository.findDueReminders.mockResolvedValue([reminder('t1'), reminder('t2')]);
      dispatchStrict.mockRejectedValue(new Error('Redis down'));
      await expect(service.sendDueReminders(NOW)).rejects.toThrow('Redis down');
      expect(repository.markReminderSent).not.toHaveBeenCalled();
    });

    it('asks for at most the cap and reports when the cap was hit', async () => {
      repository.findDueReminders.mockResolvedValue([reminder('a'), reminder('b')]);
      repository.markReminderSent.mockResolvedValue(true);
      const run = await service.sendDueReminders(NOW, 2);
      expect(repository.findDueReminders).toHaveBeenCalledWith(NOW, 2);
      expect(run.capped).toBe(true);
    });

    it('does nothing when no reminder is due', async () => {
      repository.findDueReminders.mockResolvedValue([]);
      await expect(service.sendDueReminders(NOW)).resolves.toEqual({
        notified: 0,
        superseded: 0,
        capped: false,
      });
      expect(dispatchStrict).not.toHaveBeenCalled();
    });
  });

  describe('sendOverdueNotices', () => {
    it('enqueues a TASK_OVERDUE for the assignee and then marks the task', async () => {
      const task = overdue('t1');
      repository.findOverdueUnnotified.mockResolvedValue([task]);
      repository.markOverdueNotified.mockResolvedValue(true);

      const run = await service.sendOverdueNotices(NOW);

      expect(dispatchStrict).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'rep', type: NotificationType.TASK_OVERDUE }),
      );
      expect(repository.markOverdueNotified).toHaveBeenCalledWith(task, NOW);
      expect(run).toEqual({ notified: 1, superseded: 0, capped: false });
    });

    it('counts a due date moved meanwhile as superseded', async () => {
      repository.findOverdueUnnotified.mockResolvedValue([overdue('t1')]);
      repository.markOverdueNotified.mockResolvedValue(false);
      expect((await service.sendOverdueNotices(NOW)).superseded).toBe(1);
    });
  });
});
