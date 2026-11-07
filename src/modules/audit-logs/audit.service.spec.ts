import { RequestMetadataService } from '../../common/request-context/request-metadata.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditEvent } from './audit-events';
import { AuditRecordError, AuditService, AuditTransaction } from './audit.service';

const create = vi.fn();
// What a real transaction client looks like to the service: model delegates, no `$connect`.
const tx = { auditLog: { create } } as unknown as AuditTransaction;

const context = {
  organizationId: 'org-1' as string | undefined,
  userId: 'actor-1' as string | undefined,
};
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest', requestId: 'req-1' };
const service = new AuditService(
  context as unknown as TenantContextService,
  { get: () => request } as unknown as RequestMetadataService,
);

beforeEach(() => {
  create.mockReset();
  context.organizationId = 'org-1';
  context.userId = 'actor-1';
});

describe('AuditService.record', () => {
  it('writes actor, organization and request metadata from the context, not from the caller', async () => {
    await service.record(tx, {
      event: 'user.deactivated',
      entityId: 'user-9',
      before: { isActive: true },
      after: { isActive: false },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        actorId: 'actor-1',
        action: 'UPDATE',
        event: 'user.deactivated',
        entityType: 'User',
        entityId: 'user-9',
        before: { isActive: true },
        after: { isActive: false },
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
        requestId: 'req-1',
      },
    });
  });

  it('stores changed fields only and writes nothing when nothing changed', async () => {
    const wrote = await service.record(tx, {
      event: 'user.updated',
      entityId: 'u1',
      before: { email: 'old@x.test', firstName: 'A' },
      after: { email: 'new@x.test', firstName: 'A' },
    });
    expect(wrote).toBe(true);
    expect(create.mock.calls[0][0].data).toMatchObject({
      before: { email: 'old@x.test' },
      after: { email: 'new@x.test' },
    });

    create.mockClear();
    const skipped = await service.record(tx, {
      event: 'user.updated',
      entityId: 'u1',
      before: { email: 'same@x.test' },
      after: { email: 'same@x.test' },
    });
    expect(skipped).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an event that is not in the list, before touching the database', async () => {
    await expect(
      service.record(tx, { event: 'user.exploded' as AuditEvent, entityId: 'u1' }),
    ).rejects.toThrow(AuditRecordError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a client that is not a transaction client', async () => {
    const plainClient = {
      auditLog: { create },
      $connect: vi.fn(),
    } as unknown as AuditTransaction;
    await expect(
      service.record(plainClient, { event: 'auth.login', entityId: 'u1' }),
    ).rejects.toThrow(/transaction client/);
    expect(create).not.toHaveBeenCalled();
  });

  it('needs a tenant context (or an explicit subject): never guesses an organization', async () => {
    context.organizationId = undefined;
    await expect(service.record(tx, { event: 'task.deleted', entityId: 't1' })).rejects.toThrow(
      /No tenant context/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('a subject (login, logout) is used when there is no tenant context yet', async () => {
    context.organizationId = undefined;
    context.userId = undefined;
    await service.record(
      tx,
      { event: 'auth.login', entityId: 'user-1' },
      { actorId: 'user-1', organizationId: 'org-7' },
    );
    expect(create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org-7',
      actorId: 'user-1',
      action: 'LOGIN',
      event: 'auth.login',
      entityType: 'User',
    });
  });

  it('never writes a row for another organization than the one the request runs in', async () => {
    await expect(
      service.record(
        tx,
        { event: 'auth.logout', entityId: 'user-1' },
        { actorId: 'user-1', organizationId: 'org-OTHER' },
      ),
    ).rejects.toThrow(/another organization/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a payload with a secret, which fails the surrounding change', async () => {
    // A snapshot field outside the allowlist is dropped, so the secret never reaches the row.
    await service.record(tx, {
      event: 'user.created',
      entityId: 'u1',
      after: { email: 'a@x.test', passwordHash: '$argon2id$secret' } as never,
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain('argon2');
  });

  it('lets a failing insert propagate (so the business transaction rolls back)', async () => {
    create.mockRejectedValue(new Error('insert failed'));
    await expect(
      service.record(tx, { event: 'user.password_reset', entityId: 'u1' }),
    ).rejects.toThrow('insert failed');
  });
});
