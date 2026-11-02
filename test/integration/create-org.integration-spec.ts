import * as argon2 from 'argon2';
import { parseCreateOrgArgs, type CreateOrgArgs } from '../../prisma/seed/create-org-args';
import { CliError, createOrganization } from '../../prisma/seed/create-org-command';
import { PERMISSIONS } from '../../prisma/seed/permissions';
import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { seedOrganization, seedPermissions } from '../../prisma/seed/seed-organization';
import { assertTestDatabase } from '../setup/test-database';

const args = (overrides: string[] = [], env: Record<string, string> = {}): CreateOrgArgs =>
  parseCreateOrgArgs(
    ['--name', 'Acme', '--slug', 'acme', '--admin-email', 'boss@acme.com', ...overrides],
    env,
  );

describe('org:create (integration)', () => {
  let prisma: PrismaClient;

  const rowCounts = async () => ({
    organizations: await prisma.organization.count(),
    roles: await prisma.role.count(),
    rolePermissions: await prisma.rolePermission.count(),
    users: await prisma.user.count(),
    pipelines: await prisma.pipeline.count(),
  });

  beforeAll(() => {
    prisma = createPrismaClient(assertTestDatabase(process.env.TEST_DATABASE_URL));
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Organization", "Permission" RESTART IDENTITY CASCADE',
    );
    await seedPermissions(prisma);
  });

  afterAll(() => prisma.$disconnect());

  it('creates the organization, roles, ADMIN user and default pipeline', async () => {
    const result = await createOrganization(
      prisma,
      args(['--currency', 'EUR', '--admin-first-name', 'Sara', '--admin-last-name', 'Ali']),
    );

    expect(result.status).toBe('created');
    const org = await prisma.organization.findUniqueOrThrow({
      where: { slug: 'acme' },
      include: { roles: true, pipelines: true },
    });
    expect(org).toMatchObject({ name: 'Acme', defaultCurrency: 'EUR', isActive: true });
    expect(org.roles.map((r) => r.name).sort()).toEqual(['ADMIN', 'SALES_MANAGER', 'SALES_REP']);
    expect(org.pipelines).toHaveLength(1);

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: 'boss@acme.com' },
      include: { role: { include: { permissions: true } } },
    });
    expect(admin).toMatchObject({
      organizationId: org.id,
      firstName: 'Sara',
      lastName: 'Ali',
      mustChangePassword: true,
      isActive: true,
    });
    expect(admin.role.name).toBe('ADMIN');
    expect(admin.role.permissions).toHaveLength(Object.keys(PERMISSIONS).length);
  });

  it('generates a strong password that works, and returns it only on creation', async () => {
    const created = await createOrganization(prisma, args());
    if (created.status !== 'created') throw new Error('expected created');
    const password = created.generatedPassword as string;

    expect(password).toHaveLength(24);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'boss@acme.com' } });
    expect(await argon2.verify(admin.passwordHash, password)).toBe(true);
    expect(JSON.stringify(admin)).not.toContain(password);

    const again = await createOrganization(prisma, args());
    expect(again).toEqual({ status: 'exists', organizationId: created.organizationId });
    expect(JSON.stringify(again)).not.toContain(password);
  });

  it('uses the password from the environment and does not return it', async () => {
    const secret = 'chosen-by-the-operator-1';
    const result = await createOrganization(prisma, args([], { ORG_ADMIN_PASSWORD: secret }));

    expect(result.status).toBe('created');
    expect(JSON.stringify(result)).not.toContain(secret);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'boss@acme.com' } });
    expect(await argon2.verify(admin.passwordHash, secret)).toBe(true);
    expect(admin.mustChangePassword).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await createOrganization(prisma, args());
    const before = await rowCounts();
    const hash = (await prisma.user.findUniqueOrThrow({ where: { email: 'boss@acme.com' } }))
      .passwordHash;

    const second = await createOrganization(prisma, args(['--currency', 'EGP']));

    expect(second.status).toBe('exists');
    expect(await rowCounts()).toEqual(before);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email: 'boss@acme.com' } })).passwordHash,
    ).toBe(hash);
    expect(
      (await prisma.organization.findUniqueOrThrow({ where: { slug: 'acme' } })).defaultCurrency,
    ).toBe('USD');
  });

  it('refuses an existing slug with a different admin email', async () => {
    await createOrganization(prisma, args());
    const before = await rowCounts();
    await expect(
      createOrganization(prisma, args(['--admin-email', 'other@acme.com'])),
    ).rejects.toThrow(/different admin/);
    expect(await rowCounts()).toEqual(before);
  });

  it('refuses when the email belongs to a user who is not that organization ADMIN', async () => {
    await createOrganization(prisma, args());
    const rep = await prisma.role.findFirstOrThrow({ where: { name: 'SALES_REP' } });
    await prisma.user.update({
      where: { email: 'boss@acme.com' },
      data: { roleId: rep.id },
    });
    await expect(createOrganization(prisma, args())).rejects.toThrow(CliError);
  });

  it('refuses an admin email that belongs to another organization', async () => {
    await createOrganization(prisma, args());
    const before = await rowCounts();
    await expect(createOrganization(prisma, args(['--slug', 'globex']))).rejects.toThrow(
      /belongs to another organization/,
    );
    expect(await rowCounts()).toEqual(before);
  });

  it('keeps organizations isolated from each other', async () => {
    await createOrganization(prisma, args());
    await createOrganization(
      prisma,
      args(['--slug', 'globex', '--name', 'Globex', '--admin-email', 'ceo@globex.com']),
    );
    const orgs = await prisma.organization.findMany({ include: { roles: true, users: true } });
    expect(orgs).toHaveLength(2);
    for (const org of orgs) {
      expect(org.roles).toHaveLength(3);
      expect(org.users).toHaveLength(1);
    }
  });

  it('two concurrent identical runs: one creates, the other reports "exists", no duplicates', async () => {
    const results = await Promise.all([
      createOrganization(prisma, args()),
      createOrganization(prisma, args()),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['created', 'exists']);
    expect(await rowCounts()).toMatchObject({ organizations: 1, users: 1, roles: 3, pipelines: 1 });
  });

  it('two concurrent runs for the same slug with different admins: the loser fails', async () => {
    const results = await Promise.allSettled([
      createOrganization(prisma, args()),
      createOrganization(prisma, args(['--admin-email', 'other@acme.com'])),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await rowCounts()).toMatchObject({ organizations: 1, users: 1 });
  });

  it('a failure in the middle leaves no half-built organization', async () => {
    // Without the permission catalogue the role grants cannot be written. By then the organization
    // and the roles are already inserted inside the transaction, so this proves the rollback.
    await prisma.rolePermission.deleteMany();
    await prisma.permission.deleteMany();

    await expect(createOrganization(prisma, args())).rejects.toThrow();

    expect(await rowCounts()).toEqual({
      organizations: 0,
      roles: 0,
      rolePermissions: 0,
      users: 0,
      pipelines: 0,
    });
    // ...and the same command succeeds once the cause is fixed.
    await seedPermissions(prisma);
    expect((await createOrganization(prisma, args())).status).toBe('created');
  });

  it('keeps the core seed behaviour: no forced password change by default', async () => {
    await seedOrganization(prisma, {
      name: 'Seeded',
      slug: 'seeded',
      admin: { email: 'seed@example.com', password: 'a-long-enough-password' },
    });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'seed@example.com' } });
    expect(admin).toMatchObject({
      mustChangePassword: false,
      firstName: 'Admin',
      lastName: 'User',
    });
  });
});
