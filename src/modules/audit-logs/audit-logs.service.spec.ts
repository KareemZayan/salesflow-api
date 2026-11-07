import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { encodeKeysetCursor } from '../../common/utils/keyset-cursor.util';
import {
  AUDIT_RETENTION_BATCH_SIZE,
  AUDIT_RETENTION_DAYS,
  AUDIT_RETENTION_MAX_BATCHES,
} from './audit-logs.constants';
import { AuditLogRecord, AuditLogsRepository } from './audit-logs.repository';
import { AuditLogsService } from './audit-logs.service';

const repository = { findPage: vi.fn(), purgeOlderThan: vi.fn() };
const service = new AuditLogsService(repository as unknown as AuditLogsRepository);

const actor: AuthenticatedUser = {
  userId: 'admin',
  organizationId: 'org-1',
  role: 'ADMIN',
  permissions: ['audit-logs:read'],
  mustChangePassword: false,
};

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number): AuditLogRecord => ({
  id: ID(n),
  event: 'user.created',
  action: 'CREATE',
  entityType: 'User',
  entityId: ID(900),
  actorId: ID(901),
  before: null,
  after: null,
  ipAddress: null,
  userAgent: null,
  requestId: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

beforeEach(() => vi.resetAllMocks());

describe('AuditLogsService.list', () => {
  it('asks for one extra row to learn whether another page exists, and hands out a cursor', async () => {
    repository.findPage.mockResolvedValue([row(3), row(2), row(1)]);
    const page = await service.list(actor, { limit: 2 });
    expect(repository.findPage).toHaveBeenCalledWith(expect.any(Object), undefined, 3);
    expect(page.data.map(({ id }) => id)).toEqual([ID(3), ID(2)]);
    expect(page.meta.nextCursor).toEqual(expect.any(String));
  });

  it('the last page has no cursor', async () => {
    repository.findPage.mockResolvedValue([row(2), row(1)]);
    expect((await service.list(actor, { limit: 5 })).meta.nextCursor).toBeNull();
  });

  it('continues after the position in the cursor', async () => {
    const cursor = encodeKeysetCursor('org-1', { at: row(2).createdAt, id: ID(2) });
    repository.findPage.mockResolvedValue([]);
    await service.list(actor, { limit: 10, cursor });
    expect(repository.findPage).toHaveBeenCalledWith(
      expect.any(Object),
      { at: row(2).createdAt, id: ID(2) },
      11,
    );
  });

  it('a cursor from another organization is a 400 INVALID_CURSOR', async () => {
    const foreign = encodeKeysetCursor('org-2', { at: row(2).createdAt, id: ID(2) });
    const error = (await service
      .list(actor, { limit: 10, cursor: foreign })
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(400);
    expect((error.getResponse() as { code: string }).code).toBe('INVALID_CURSOR');
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('passes the filters and the date range through as Dates', async () => {
    repository.findPage.mockResolvedValue([]);
    await service.list(actor, {
      limit: 10,
      actorId: ID(1),
      entityType: 'User',
      entityId: ID(2),
      event: 'user.created',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    });
    expect(repository.findPage).toHaveBeenCalledWith(
      {
        actorId: ID(1),
        entityType: 'User',
        entityId: ID(2),
        event: 'user.created',
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-02-01T00:00:00Z'),
      },
      undefined,
      11,
    );
  });

  it('never runs a count query (the repository has none)', () => {
    expect(Object.keys(repository)).not.toContain('count');
  });
});

describe('AuditLogsService.purgeExpired', () => {
  it('deletes rows older than the retention period, in bounded batches', async () => {
    repository.purgeOlderThan.mockResolvedValue(7);
    const now = new Date('2026-11-07T03:45:00Z');
    expect(await service.purgeExpired(now)).toBe(7);
    expect(repository.purgeOlderThan).toHaveBeenCalledWith(
      new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000),
      AUDIT_RETENTION_BATCH_SIZE,
      AUDIT_RETENTION_MAX_BATCHES,
    );
  });

  it('keeps a conservative default of at least a year', () => {
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThanOrEqual(365);
  });
});
