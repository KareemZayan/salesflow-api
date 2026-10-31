import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { createTenantClient } from '../../src/common/tenant/tenant-scope.extension';
import {
  MissingTenantContextError,
  TenantScopeViolationError,
} from '../../src/common/tenant/tenant-scope';
import { assertTestDatabase } from '../setup/test-database';

interface Tenant {
  orgId: string;
  userId: string;
}

describe('tenant scoping extension (integration)', () => {
  let prisma: PrismaClient;
  let tenantContext: TenantContextService;
  let db: ReturnType<typeof createTenantClient>;
  let a: Tenant;
  let b: Tenant;

  // Rows are set up with the unscoped client: tests must not depend on the code under test.
  const createTenant = async (slug: string): Promise<Tenant> => {
    const org = await prisma.organization.create({ data: { name: slug, slug } });
    const role = await prisma.role.create({
      data: { organizationId: org.id, name: 'ADMIN', isSystem: true },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        roleId: role.id,
        email: `${slug}@example.com`,
        passwordHash: 'x',
        firstName: slug,
        lastName: 'User',
      },
    });
    return { orgId: org.id, userId: user.id };
  };

  const asA = <T>(fn: () => Promise<T>) => tenantContext.run(a.orgId, fn);
  const asB = <T>(fn: () => Promise<T>) => tenantContext.run(b.orgId, fn);
  const newCompany = (tenant: Tenant, name = 'Acme') =>
    db.company.create({ data: { ownerId: tenant.userId, name } as never });

  beforeAll(async () => {
    prisma = createPrismaClient(assertTestDatabase(process.env.TEST_DATABASE_URL));
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [TenantContextService],
    }).compile();
    tenantContext = module.get(TenantContextService);
    db = createTenantClient(prisma, tenantContext);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Organization", "Permission" RESTART IDENTITY CASCADE',
    );
    a = await createTenant('org-a');
    b = await createTenant('org-b');
  });

  afterAll(() => prisma.$disconnect());

  it('throws instead of running an unscoped query when there is no tenant context', async () => {
    await expect(db.company.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(newCompany(a)).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('keeps concurrent tenants apart', async () => {
    await asA(() => newCompany(a, 'only-a'));
    await asB(() => newCompany(b, 'only-b'));

    const [seenByA, seenByB] = await Promise.all([
      asA(() => db.company.findMany()),
      asB(() => db.company.findMany()),
    ]);

    expect(seenByA.map((c) => c.name)).toEqual(['only-a']);
    expect(seenByB.map((c) => c.name)).toEqual(['only-b']);
  });

  describe('isolation between organizations', () => {
    it('cannot read, update or delete another organization rows (non-soft-delete model)', async () => {
      const task = await prisma.task.create({
        data: { organizationId: a.orgId, assigneeId: a.userId, createdById: a.userId, title: 't' },
      });

      await asB(async () => {
        expect(await db.task.findMany()).toEqual([]);
        expect(await db.task.count()).toBe(0);
        expect(await db.task.findUnique({ where: { id: task.id } })).toBeNull();
        expect(await db.task.findFirst({ where: { id: task.id } })).toBeNull();
        expect(await db.task.updateMany({ where: { id: task.id }, data: { title: 'x' } })).toEqual({
          count: 0,
        });
        expect(await db.task.deleteMany({ where: { id: task.id } })).toEqual({ count: 0 });
        await expect(
          db.task.update({ where: { id: task.id }, data: { title: 'x' } }),
        ).rejects.toMatchObject({ code: 'P2025' });
        await expect(db.task.delete({ where: { id: task.id } })).rejects.toMatchObject({
          code: 'P2025',
        });
      });

      expect(await prisma.task.findUnique({ where: { id: task.id } })).toMatchObject({
        title: 't',
      });
    });

    it('findUniqueOrThrow on a foreign id raises P2025 (mapped to 404 by the filter)', async () => {
      const company = await asA(() => newCompany(a));
      await expect(
        asB(() => db.company.findUniqueOrThrow({ where: { id: company.id } })),
      ).rejects.toMatchObject({ code: 'P2025' });
    });

    it('scopes User reads too (the Users module does not filter manually)', async () => {
      expect((await asA(() => db.user.findMany())).map((u) => u.id)).toEqual([a.userId]);
      expect(await asA(() => db.user.findUnique({ where: { id: b.userId } }))).toBeNull();
    });

    it('lets the unscoped client reach any tenant (login/refresh path)', async () => {
      expect(
        await prisma.user.findUnique({ where: { email: 'org-b@example.com' } }),
      ).not.toBeNull();
    });

    it('rejects a cross-organization link at the database (composite FK backstop)', async () => {
      const foreignCompany = await asB(() => newCompany(b));
      await expect(
        asA(() =>
          db.contact.create({
            data: {
              ownerId: a.userId,
              firstName: 'x',
              lastName: 'y',
              companyId: foreignCompany.id,
            } as never,
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  describe('writes', () => {
    it('create injects the organization and overrides a spoofed one', async () => {
      const company = await asA(() =>
        db.company.create({
          data: { ownerId: a.userId, name: 'x', organizationId: b.orgId } as never,
        }),
      );
      expect(company.organizationId).toBe(a.orgId);
    });

    it('createMany and createManyAndReturn inject the organization', async () => {
      await asA(() =>
        db.company.createMany({
          data: [
            { ownerId: a.userId, name: 'one' },
            { ownerId: a.userId, name: 'two' },
          ] as never,
        }),
      );
      const returned = await asA(() =>
        db.company.createManyAndReturn({ data: [{ ownerId: a.userId, name: 'three' }] as never }),
      );

      const all = await prisma.company.findMany();
      expect(all).toHaveLength(3);
      expect(all.every((c) => c.organizationId === a.orgId)).toBe(true);
      expect(returned[0].organizationId).toBe(a.orgId);
    });

    it('upsert injects the organization on create and scopes the lookup', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const upsert = (name: string) =>
        db.company.upsert({
          where: { id },
          create: { id, ownerId: a.userId, name } as never,
          update: { name },
        });

      const created = await asA(() => upsert('first'));
      expect(created.organizationId).toBe(a.orgId);
      expect(await asA(() => upsert('second'))).toMatchObject({ id, name: 'second' });
      expect(await prisma.company.count()).toBe(1);
    });

    it('rejects organizationId in update, updateMany and the update branch of upsert', async () => {
      const company = await asA(() => newCompany(a));
      const data = { organizationId: b.orgId } as never;

      await asA(async () => {
        await expect(db.company.update({ where: { id: company.id }, data })).rejects.toBeInstanceOf(
          TenantScopeViolationError,
        );
        await expect(db.company.updateMany({ data })).rejects.toBeInstanceOf(
          TenantScopeViolationError,
        );
        await expect(
          db.company.upsert({
            where: { id: company.id },
            create: { ownerId: a.userId, name: 'x' } as never,
            update: data,
          }),
        ).rejects.toBeInstanceOf(TenantScopeViolationError);
      });
    });
  });

  describe('soft delete', () => {
    it('delete becomes an update of deletedAt; the row survives for the unscoped client', async () => {
      const company = await asA(() => newCompany(a));

      await asA(() => db.company.delete({ where: { id: company.id } }));

      expect(await asA(() => db.company.findMany())).toEqual([]);
      expect(await asA(() => db.company.findUnique({ where: { id: company.id } }))).toBeNull();
      const raw = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
      expect(raw.deletedAt).toBeInstanceOf(Date);
    });

    it('deleteMany soft-deletes only live rows of the current tenant', async () => {
      await asA(() => newCompany(a, 'a1'));
      await asA(() => newCompany(a, 'a2'));
      await asB(() => newCompany(b, 'b1'));

      expect(await asA(() => db.company.deleteMany())).toEqual({ count: 2 });
      expect(await asA(() => db.company.deleteMany())).toEqual({ count: 0 });
      expect(await asB(() => db.company.count())).toBe(1);
      expect(await prisma.company.count()).toBe(3);
    });

    it('update and delete on a soft-deleted row fail with P2025', async () => {
      const company = await asA(() => newCompany(a));
      await asA(() => db.company.delete({ where: { id: company.id } }));

      await asA(async () => {
        await expect(
          db.company.update({ where: { id: company.id }, data: { name: 'x' } }),
        ).rejects.toMatchObject({ code: 'P2025' });
        await expect(db.company.delete({ where: { id: company.id } })).rejects.toMatchObject({
          code: 'P2025',
        });
      });
    });

    it('withDeleted() can read and restore a soft-deleted row', async () => {
      const company = await asA(() => newCompany(a));
      await asA(() => db.company.delete({ where: { id: company.id } }));

      await asA(() =>
        tenantContext.withDeleted(async () => {
          expect(await db.company.findMany()).toHaveLength(1);
          await db.company.update({ where: { id: company.id }, data: { deletedAt: null } });
        }),
      );

      expect(await asA(() => db.company.findMany())).toHaveLength(1);
    });

    it('a real DELETE is only possible through the unscoped client', async () => {
      const company = await asA(() => newCompany(a));
      await prisma.company.delete({ where: { id: company.id } });
      expect(await prisma.company.count()).toBe(0);
    });

    it('does not block re-creating a record after a soft delete (no business unique on soft-delete models)', async () => {
      const first = await asA(() => newCompany(a, 'Acme'));
      const lead = (email: string) =>
        db.lead.create({
          data: {
            ownerId: a.userId,
            firstName: 'x',
            lastName: 'y',
            email,
            source: 'OTHER',
          } as never,
        });
      const firstLead = await asA(() => lead('same@example.com'));

      await asA(async () => {
        await db.company.delete({ where: { id: first.id } });
        await db.lead.delete({ where: { id: firstLead.id } });
        await newCompany(a, 'Acme');
        await lead('same@example.com');
      });

      expect(await asA(() => db.company.count())).toBe(1);
      expect(await asA(() => db.lead.count())).toBe(1);
    });
  });

  describe('$transaction', () => {
    it('interactive form keeps scoping and soft delete, and rolls back as a unit', async () => {
      const foreign = await asB(() => newCompany(b, 'foreign'));
      const mine = await asA(() => newCompany(a, 'mine'));

      await asA(async () => {
        await db.$transaction(async (tx) => {
          const created = await tx.company.create({
            data: { ownerId: a.userId, name: 'in-tx' } as never,
          });
          expect(created.organizationId).toBe(a.orgId);
          expect(await tx.company.findUnique({ where: { id: foreign.id } })).toBeNull();
          expect((await tx.company.findMany()).map((c) => c.name).sort()).toEqual([
            'in-tx',
            'mine',
          ]);
        });

        await expect(
          db.$transaction(async (tx) => {
            await tx.company.delete({ where: { id: mine.id } });
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
      });

      // The soft delete ran inside the transaction, so the abort undid it.
      expect(
        (await prisma.company.findUniqueOrThrow({ where: { id: mine.id } })).deletedAt,
      ).toBeNull();
    });

    it('array form keeps scoping and soft delete', async () => {
      await asA(() => newCompany(a, 'a1'));
      await asB(() => newCompany(b, 'b1'));

      const [visible, count, deleted] = await asA(() =>
        db.$transaction([db.company.findMany(), db.company.count(), db.company.deleteMany()]),
      );

      expect(visible.map((c) => c.name)).toEqual(['a1']);
      expect(count).toBe(1);
      expect(deleted).toEqual({ count: 1 });
      expect(await asB(() => db.company.count())).toBe(1);
      expect(await asA(() => db.company.count())).toBe(0);
    });

    it('interactive form without tenant context throws', async () => {
      await expect(db.$transaction(async (tx) => tx.company.findMany())).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
    });
  });
});
