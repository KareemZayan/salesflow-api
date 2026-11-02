import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { createTenantClient } from '../../src/common/tenant/tenant-scope.extension';
import { containsAny } from '../../src/common/utils/search.util';
import { Prisma } from '../../src/generated/prisma/client';
import { acquireLock } from '../../src/infrastructure/prisma/advisory-lock';
import { assertTestDatabase } from '../setup/test-database';

// Two behaviours the Companies module relies on, proven against real Postgres instead of assumed:
//  1. what Prisma does with `%`, `_` and `\` inside `contains`
//  2. the tenant extension does not filter soft-deleted rows inside nested relation counts (ADR 0002)
describe('search escaping and nested soft-delete filters (integration)', () => {
  let prisma: PrismaClient;
  let tenantContext: TenantContextService;
  let db: ReturnType<typeof createTenantClient>;
  let orgId: string;
  let userId: string;

  const names = ['Acme', '100% Pure', 'snake_case', 'back\\slash', 'snakeXcase'];
  const search = async (q: string): Promise<string[]> => {
    const where = containsAny<Prisma.CompanyWhereInput>(q, ['name']);
    const rows = await tenantContext.run(orgId, () =>
      db.company.findMany({ where, select: { name: true }, orderBy: { name: 'asc' } }),
    );
    return rows.map(({ name }) => name);
  };

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
    const org = await prisma.organization.create({ data: { name: 'o', slug: 'o' } });
    const role = await prisma.role.create({
      data: { organizationId: org.id, name: 'ADMIN', isSystem: true },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        roleId: role.id,
        email: 'o@example.com',
        passwordHash: 'x',
        firstName: 'o',
        lastName: 'o',
      },
    });
    orgId = org.id;
    userId = user.id;
    await prisma.company.createMany({
      data: names.map((name) => ({ organizationId: orgId, ownerId: userId, name })),
    });
  });

  afterAll(() => prisma.$disconnect());

  it('Prisma does NOT escape LIKE wildcards, which is why containsAny does', async () => {
    const raw = await tenantContext.run(orgId, () =>
      db.company.findMany({ where: { name: { contains: '%', mode: 'insensitive' } } }),
    );
    expect(raw).toHaveLength(names.length);
  });

  it('`%` matches only a literal percent sign', async () => {
    expect(await search('%')).toEqual(['100% Pure']);
  });

  it('`_` matches only a literal underscore, not "any character"', async () => {
    expect(await search('_')).toEqual(['snake_case']);
    expect(await search('snake_case')).toEqual(['snake_case']);
  });

  it('a backslash is literal and cannot escape the wildcard that follows it', async () => {
    expect(await search('\\')).toEqual(['back\\slash']);
    expect(await search('\\%')).toEqual([]);
  });

  it('ordinary text is still a case-insensitive contains', async () => {
    expect(await search('ACM')).toEqual(['Acme']);
  });

  it('a blank search adds no filter', () => {
    expect(containsAny('   ', ['name'])).toBeUndefined();
    expect(containsAny(undefined, ['name'])).toBeUndefined();
  });

  it('nested relation counts include soft-deleted rows unless deletedAt: null is explicit', async () => {
    const company = await prisma.company.findFirstOrThrow({ where: { name: 'Acme' } });
    const base = { organizationId: orgId, ownerId: userId, companyId: company.id, lastName: 'L' };
    await prisma.contact.create({ data: { ...base, firstName: 'live' } });
    await prisma.contact.create({ data: { ...base, firstName: 'gone', deletedAt: new Date() } });

    const [unfiltered, explicit] = await tenantContext.run(orgId, () =>
      Promise.all([
        db.company.findFirstOrThrow({
          where: { id: company.id },
          select: { _count: { select: { contacts: true } } },
        }),
        db.company.findFirstOrThrow({
          where: { id: company.id },
          select: { _count: { select: { contacts: { where: { deletedAt: null } } } } },
        }),
      ]),
    );
    expect(unfiltered._count.contacts).toBe(2);
    expect(explicit._count.contacts).toBe(1);
  });

  it('advisory locks of the same key exclude each other; different keys do not', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    const first = prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'company', 'same');
      order.push('first-locked');
      await held;
      order.push('first-done');
    });
    await vi.waitFor(() => expect(order).toEqual(['first-locked']));

    const sameKey = prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'company', 'same');
      order.push('same-key');
    });
    await prisma.$transaction(async (tx) => {
      await acquireLock(tx, 'company', 'other');
      await acquireLock(tx, 'org', 'same'); // a different kind with the same id is a different lock
      order.push('other-key');
    });
    expect(order).toEqual(['first-locked', 'other-key']);

    release();
    await Promise.all([first, sameKey]);
    expect(order).toEqual(['first-locked', 'other-key', 'first-done', 'same-key']);
  });
});
