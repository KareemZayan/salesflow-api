import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { NotificationType } from '../../generated/prisma/client';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

const repository = {
  findPage: vi.fn(),
  countUnread: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  createIfAbsent: vi.fn(),
};
const service = new NotificationsService(repository as unknown as NotificationsRepository);
const actor = { userId: 'me', organizationId: 'org' } as AuthenticatedUser;
const query = { page: 1, limit: 20, sortOrder: 'desc' } as const;
const record = {
  id: 'n1',
  type: NotificationType.TASK_ASSIGNED,
  title: 'T',
  body: null,
  payload: { taskId: 't', junk: 5 },
  readAt: null,
  createdAt: new Date(),
};

describe('NotificationsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only the caller own notifications and keeps the page meta', async () => {
    const meta = { page: 1, limit: 20, total: 1, totalPages: 1 };
    repository.findPage.mockResolvedValue({ data: [record], meta });
    const page = await service.list(actor, query);
    expect(repository.findPage).toHaveBeenCalledWith('me', expect.any(Object));
    expect(page.meta).toBe(meta);
    // Only string values of the flat payload map reach the client.
    expect(page.data[0].payload).toEqual({ taskId: 't' });
  });

  it('returns a null payload for anything that is not an object', async () => {
    repository.findPage.mockResolvedValue({
      data: [
        { ...record, payload: 'x' },
        { ...record, payload: null },
        { ...record, payload: [1] },
      ],
      meta: {},
    });
    const page = await service.list(actor, query);
    expect(page.data.map((n) => n.payload)).toEqual([null, null, null]);
  });

  it('counts the unread notifications of the caller', async () => {
    repository.countUnread.mockResolvedValue(4);
    await expect(service.unreadCount(actor)).resolves.toEqual({ count: 4 });
    expect(repository.countUnread).toHaveBeenCalledWith('me');
  });

  it('marks one as read for the caller, and answers 404 when it is not theirs', async () => {
    repository.markRead.mockResolvedValueOnce(record);
    await expect(service.markRead(actor, 'n1')).resolves.toMatchObject({ id: 'n1' });
    expect(repository.markRead).toHaveBeenCalledWith('me', 'n1', expect.any(Date));

    repository.markRead.mockResolvedValueOnce(null);
    const error = await service.markRead(actor, 'n2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
  });

  it('marks all as read and reports how many changed', async () => {
    repository.markAllRead.mockResolvedValue(3);
    await expect(service.markAllRead(actor)).resolves.toEqual({ updated: 3 });
  });

  it('delegates the job write to the repository and returns its outcome', async () => {
    repository.createIfAbsent.mockResolvedValue('duplicate');
    const job = { dedupeKey: 'k' } as never;
    await expect(service.createFromJob(job)).resolves.toBe('duplicate');
    expect(repository.createIfAbsent).toHaveBeenCalledWith(job);
  });
});
