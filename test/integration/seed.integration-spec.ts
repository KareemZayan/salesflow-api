import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { seedDemoData } from '../../prisma/seed/demo-data';
import { PERMISSIONS } from '../../prisma/seed/permissions';
import { seedOrganization, seedPermissions } from '../../prisma/seed/seed-organization';
import { assertTestDatabase } from '../setup/test-database';

const PASSWORD = 'integration-test-password';
const ADMIN = { email: 'admin@example.com', password: PASSWORD };

describe('database schema and seed (integration)', () => {
  let prisma: PrismaClient;

  const counts = async () => ({
    permissions: await prisma.permission.count(),
    organizations: await prisma.organization.count(),
    roles: await prisma.role.count(),
    rolePermissions: await prisma.rolePermission.count(),
    users: await prisma.user.count(),
    pipelines: await prisma.pipeline.count(),
    stages: await prisma.pipelineStage.count(),
    companies: await prisma.company.count(),
    contacts: await prisma.contact.count(),
    leads: await prisma.lead.count(),
    deals: await prisma.deal.count(),
    stageHistory: await prisma.dealStageHistory.count(),
  });

  const seedCore = async (slug = 'acme', admin = ADMIN) => {
    await seedPermissions(prisma);
    return seedOrganization(prisma, { name: `Org ${slug}`, slug, admin });
  };

  beforeAll(() => {
    // Defense in depth: the global setup already checked, but this suite TRUNCATEs.
    prisma = createPrismaClient(assertTestDatabase(process.env.TEST_DATABASE_URL));
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Organization", "Permission" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(() => prisma.$disconnect());

  describe('core seed', () => {
    it('creates permissions, default roles, an admin and the default pipeline', async () => {
      await seedCore();

      expect(await counts()).toMatchObject({
        permissions: Object.keys(PERMISSIONS).length,
        organizations: 1,
        roles: 3,
        users: 1,
        pipelines: 1,
        stages: 6,
      });
      const admin = await prisma.user.findUniqueOrThrow({
        where: { email: ADMIN.email },
        include: { role: { include: { permissions: true } } },
      });
      expect(admin.role.name).toBe('ADMIN');
      expect(admin.role.permissions).toHaveLength(Object.keys(PERMISSIONS).length);
      expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('is idempotent: a second run changes nothing', async () => {
      await seedCore();
      const first = await counts();
      await seedCore();

      expect(await counts()).toEqual(first);
    });

    it('does not overwrite an existing admin password on re-run', async () => {
      await seedCore();
      await prisma.user.update({
        where: { email: ADMIN.email },
        data: { passwordHash: 'changed-by-the-admin' },
      });

      await seedCore('acme', { ...ADMIN, password: 'a-different-seed-password' });

      const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });
      expect(admin.passwordHash).toBe('changed-by-the-admin');
    });

    it('keeps admin edits to the default pipeline and role permissions', async () => {
      await seedCore();
      await prisma.pipeline.updateMany({ data: { name: 'Renamed' } });
      await prisma.rolePermission.deleteMany({ where: { role: { name: 'ADMIN' } } });

      await seedCore();

      expect(await prisma.pipeline.count()).toBe(1);
      expect((await prisma.pipeline.findFirstOrThrow()).name).toBe('Renamed');
      // Missing grants are restored, never duplicated.
      expect(await prisma.rolePermission.count({ where: { role: { name: 'ADMIN' } } })).toBe(
        Object.keys(PERMISSIONS).length,
      );
    });

    it('refuses an admin email that belongs to another organization', async () => {
      await seedCore('org-a');

      await expect(seedCore('org-b')).rejects.toThrow(/another organization/);
    });
  });

  describe('demo data', () => {
    it('creates a small data set and is idempotent', async () => {
      const { organizationId } = await seedCore();

      expect(await seedDemoData(prisma, { organizationId, password: PASSWORD })).toBe(true);
      const first = await counts();
      expect(first).toMatchObject({ users: 3, companies: 2, contacts: 2, leads: 3, deals: 2 });
      expect(first.stageHistory).toBe(4);

      expect(await seedDemoData(prisma, { organizationId, password: PASSWORD })).toBe(false);
      expect(await counts()).toEqual(first);
    });
  });

  describe('multi-tenant constraints', () => {
    it('rejects a link to a record of another organization (composite FK)', async () => {
      const a = await seedCore('org-a');
      const b = await seedCore('org-b', { ...ADMIN, email: 'admin-b@example.com' });
      const companyOfA = await prisma.company.create({
        data: { organizationId: a.organizationId, ownerId: a.adminId, name: 'A Co' },
      });

      await expect(
        prisma.contact.create({
          data: {
            organizationId: b.organizationId,
            ownerId: b.adminId,
            companyId: companyOfA.id,
            firstName: 'Cross',
            lastName: 'Org',
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts the same link inside one organization and a null optional link', async () => {
      const a = await seedCore('org-a');
      const company = await prisma.company.create({
        data: { organizationId: a.organizationId, ownerId: a.adminId, name: 'A Co' },
      });
      const base = { organizationId: a.organizationId, ownerId: a.adminId, lastName: 'Ok' };

      await expect(
        prisma.contact.create({ data: { ...base, firstName: 'Linked', companyId: company.id } }),
      ).resolves.toBeDefined();
      await expect(
        prisma.contact.create({ data: { ...base, firstName: 'Unlinked' } }),
      ).resolves.toBeDefined();
    });

    it('restricts deleting a company that still has contacts', async () => {
      const a = await seedCore('org-a');
      const company = await prisma.company.create({
        data: { organizationId: a.organizationId, ownerId: a.adminId, name: 'A Co' },
      });
      await prisma.contact.create({
        data: {
          organizationId: a.organizationId,
          ownerId: a.adminId,
          companyId: company.id,
          firstName: 'Kept',
          lastName: 'Contact',
        },
      });

      await expect(prisma.company.delete({ where: { id: company.id } })).rejects.toThrow();
    });

    it('enforces one default pipeline per organization (partial unique index)', async () => {
      const a = await seedCore('org-a');

      await expect(
        prisma.pipeline.create({
          data: { organizationId: a.organizationId, name: 'Second default', isDefault: true },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.pipeline.create({
          data: { organizationId: a.organizationId, name: 'Not default', isDefault: false },
        }),
      ).resolves.toBeDefined();
    });

    it('has the raw-SQL partial index on open tasks', async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'Task_open_status_dueDate_idx'`;

      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('WHERE');
    });
  });
});
