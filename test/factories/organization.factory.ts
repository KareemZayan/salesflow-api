import * as argon2 from 'argon2';
import type { PrismaClient } from '../../prisma/seed/prisma-client';
import { ROLE_NAMES, type RoleName } from '../../prisma/seed/permissions';
import { seedOrganization } from '../../prisma/seed/seed-organization';

export const TEST_PASSWORD = 'correct-horse-battery';

// Hashing is slow by design; one shared hash keeps the suite fast.
let sharedHash: Promise<string> | undefined;
export const testPasswordHash = (): Promise<string> => (sharedHash ??= argon2.hash(TEST_PASSWORD));

export interface TestOrganization {
  id: string;
  slug: string;
  admin: TestUser;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

// The real onboarding path (roles, role permissions, default pipeline, first admin), so tests run
// against exactly what production creates. Call resetDatabase first: it restores the permissions.
export async function createOrganization(
  prisma: PrismaClient,
  slug: string,
): Promise<TestOrganization> {
  const email = `admin@${slug}.test`;
  const { organizationId, adminId } = await seedOrganization(prisma, {
    name: slug,
    slug,
    admin: { email, password: TEST_PASSWORD },
  });
  return { id: organizationId, slug, admin: { id: adminId, email, password: TEST_PASSWORD } };
}

export interface UserOptions {
  role?: RoleName;
  email?: string;
  managerId?: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}

let sequence = 0;

export async function createUser(
  prisma: PrismaClient,
  organization: Pick<TestOrganization, 'id' | 'slug'>,
  options: UserOptions = {},
): Promise<TestUser> {
  const role = await prisma.role.findUniqueOrThrow({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: options.role ?? ROLE_NAMES.SALES_REP,
      },
    },
  });
  const email = options.email ?? `user${++sequence}@${organization.slug}.test`;
  const user = await prisma.user.create({
    data: {
      organizationId: organization.id,
      roleId: role.id,
      managerId: options.managerId,
      email,
      passwordHash: await testPasswordHash(),
      firstName: 'Test',
      lastName: 'User',
      isActive: options.isActive ?? true,
      mustChangePassword: options.mustChangePassword ?? false,
    },
  });
  return { id: user.id, email, password: TEST_PASSWORD };
}
