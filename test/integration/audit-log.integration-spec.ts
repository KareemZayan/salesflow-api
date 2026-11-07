import { randomUUID } from 'node:crypto';
import { allowAuditRetentionDelete } from '../../src/infrastructure/prisma/audit-retention-flag';
import { AuditService } from '../../src/modules/audit-logs/audit.service';
import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { seedPermissions } from '../../prisma/seed/seed-organization';
import { createOrganization } from '../factories/organization.factory';
import { assertTestDatabase } from '../setup/test-database';

// The database half of ADR 0014: the append-only trigger and the retention flag, against a real
// PostgreSQL.
describe('AuditLog append-only trigger (integration)', () => {
  let prisma: PrismaClient;
  let organizationId: string;

  const insert = () =>
    prisma.auditLog.create({
      data: {
        organizationId,
        event: 'user.created',
        action: 'CREATE',
        entityType: 'User',
        entityId: randomUUID(),
        after: { email: 'a@example.test' },
      },
    });
  const flag = async () =>
    (
      await prisma.$queryRaw<{ value: string | null }[]>`
      SELECT current_setting('app.audit_retention', true) AS value`
    )[0].value;

  beforeAll(() => {
    prisma = createPrismaClient(assertTestDatabase(process.env.TEST_DATABASE_URL));
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Organization", "Permission" RESTART IDENTITY CASCADE',
    );
    await seedPermissions(prisma);
    organizationId = (await createOrganization(prisma, 'acme')).id;
  });

  afterAll(() => prisma.$disconnect());

  it('accepts inserts', async () => {
    await insert();
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('rejects UPDATE, however it is issued, and leaves the row untouched', async () => {
    const row = await insert();
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { event: 'user.deleted' } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.auditLog.updateMany({ data: { after: { email: 'forged@example.test' } } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`UPDATE "AuditLog" SET "actorId" = NULL WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toEqual(row);
  });

  it('rejects DELETE, however it is issued', async () => {
    const row = await insert();
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "AuditLog"`).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('allows DELETE only inside a transaction that turned the retention flag on', async () => {
    await insert();
    await insert();
    const deleted = await prisma.$transaction(async (tx) => {
      await allowAuditRetentionDelete(tx);
      return (await tx.auditLog.deleteMany({})).count;
    });
    expect(deleted).toBe(2);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('the flag ends with the transaction: no pooled connection keeps it on', async () => {
    await insert();
    await prisma.$transaction(async (tx) => {
      await allowAuditRetentionDelete(tx);
      expect(
        (
          await tx.$queryRaw<
            { value: string }[]
          >`SELECT current_setting('app.audit_retention') AS value`
        )[0].value,
      ).toBe('on');
    });

    // Many concurrent queries spread over the pool: none of its connections may still say 'on'.
    const seen = await Promise.all(Array.from({ length: 20 }, flag));
    expect(seen.filter((value) => value === 'on')).toEqual([]);
    // And a delete outside the transaction is rejected again.
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('a rolled-back retention transaction clears the flag and deletes nothing', async () => {
    await insert();
    await expect(
      prisma.$transaction(async (tx) => {
        await allowAuditRetentionDelete(tx);
        await tx.auditLog.deleteMany({});
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prisma.auditLog.count()).toBe(1);
    expect((await Promise.all(Array.from({ length: 20 }, flag))).filter((v) => v === 'on')).toEqual(
      [],
    );
  });

  it('TRUNCATE is not blocked (the test reset helper relies on it); production code never issues one', async () => {
    await insert();
    await prisma.$executeRawUnsafe('TRUNCATE "AuditLog"');
    expect(await prisma.auditLog.count()).toBe(0);
  });

  describe('AuditService against a real client', () => {
    const service = new AuditService(
      { organizationId: undefined, userId: undefined } as never,
      { get: () => ({ ipAddress: null, userAgent: null, requestId: null }) } as never,
    );

    it('a transaction client has no $connect; a PrismaService does, and is refused', async () => {
      expect('$connect' in prisma).toBe(true);
      await prisma.$transaction(async (tx) => {
        expect('$connect' in tx).toBe(false);
      });
      await expect(
        service.record(
          prisma,
          { event: 'auth.login', entityId: randomUUID() },
          {
            actorId: randomUUID(),
            organizationId,
          },
        ),
      ).rejects.toThrow(/transaction client/);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('writes through a real transaction client and rolls back with it', async () => {
      const actorId = (await prisma.user.findFirstOrThrow({ where: { organizationId } })).id;
      const subject = { actorId, organizationId };
      await prisma.$transaction(async (tx) => {
        await service.record(tx, { event: 'auth.login', entityId: actorId }, subject);
      });
      expect(await prisma.auditLog.count()).toBe(1);

      await expect(
        prisma.$transaction(async (tx) => {
          await service.record(tx, { event: 'auth.logout', entityId: actorId }, subject);
          throw new Error('business failure after the audit insert');
        }),
      ).rejects.toThrow('business failure');
      expect(await prisma.auditLog.count()).toBe(1);
    });

    it('survives the deletion of the audited entity (no FK to it)', async () => {
      const entityId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await service.record(
          tx,
          { event: 'task.deleted', entityId, before: { assigneeId: randomUUID() } },
          {
            actorId: (await tx.user.findFirstOrThrow({ where: { organizationId } })).id,
            organizationId,
          },
        );
      });
      const row = await prisma.auditLog.findFirstOrThrow({ where: { entityId } });
      expect(row.entityType).toBe('Task');
    });
  });
});
