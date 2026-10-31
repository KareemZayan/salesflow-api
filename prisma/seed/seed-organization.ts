import * as argon2 from 'argon2';
import { DEFAULT_ROLES, PERMISSIONS, ROLE_NAMES } from './permissions';
import type { PrismaClient } from './prisma-client';

export interface SeedOrganizationInput {
  name: string;
  slug: string;
  admin: { email: string; password: string };
}

export interface SeededOrganization {
  organizationId: string;
  adminId: string;
}

// Default pipeline stages, in board order. `probability` is the win percentage.
const DEFAULT_PIPELINE = {
  name: 'Sales Pipeline',
  stages: [
    { name: 'Prospecting', probability: 10 },
    { name: 'Qualified', probability: 25 },
    { name: 'Proposal', probability: 50 },
    { name: 'Negotiation', probability: 75 },
    { name: 'Won', probability: 100, isWon: true },
    { name: 'Lost', probability: 0, isLost: true },
  ],
} as const;

// Global catalogue, owned by code: re-running refreshes descriptions and adds new keys.
export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { key, description },
    });
  }
}

// Creates everything a tenant needs to be usable: org, default roles, first admin, default pipeline.
// Idempotent on natural keys (slug, role name, email). Shared with the future `org:create` script.
// Existing rows are never overwritten, so admin edits (password, renamed pipeline, extra role
// permissions) survive a re-run.
export async function seedOrganization(
  prisma: PrismaClient,
  input: SeedOrganizationInput,
): Promise<SeededOrganization> {
  const email = input.admin.email.toLowerCase();
  const existingAdmin = await prisma.user.findUnique({
    where: { email },
    select: { id: true, organizationId: true },
  });
  // Hashing is slow by design; skip it when the admin already exists.
  const passwordHash = existingAdmin ? null : await argon2.hash(input.admin.password);
  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissions.map(({ id, key }) => [key, id]));

  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.upsert({
      where: { slug: input.slug },
      update: {},
      create: { name: input.name, slug: input.slug },
    });

    if (existingAdmin && existingAdmin.organizationId !== org.id) {
      throw new Error(`Admin email ${email} already belongs to another organization`);
    }

    const roleIdByName = new Map<string, string>();
    for (const [name, definition] of Object.entries(DEFAULT_ROLES)) {
      const role = await tx.role.upsert({
        where: { organizationId_name: { organizationId: org.id, name } },
        update: {},
        create: {
          organizationId: org.id,
          name,
          description: definition.description,
          isSystem: true,
        },
      });
      roleIdByName.set(name, role.id);
      // skipDuplicates adds missing permissions without touching ones already granted.
      await tx.rolePermission.createMany({
        data: definition.permissions.map((key) => ({
          roleId: role.id,
          permissionId: permissionIdByKey.get(key) as string,
        })),
        skipDuplicates: true,
      });
    }

    const adminId =
      existingAdmin?.id ??
      (
        await tx.user.create({
          data: {
            organizationId: org.id,
            roleId: roleIdByName.get(ROLE_NAMES.ADMIN) as string,
            email,
            passwordHash: passwordHash as string,
            firstName: 'Admin',
            lastName: 'User',
          },
        })
      ).id;

    // Only seed a pipeline into an org that has none: admins may rename or delete the default,
    // and a second default would violate the one-default-per-org index.
    if ((await tx.pipeline.count({ where: { organizationId: org.id } })) === 0) {
      await tx.pipeline.create({
        data: {
          organizationId: org.id,
          name: DEFAULT_PIPELINE.name,
          isDefault: true,
          stages: {
            // organizationId comes from the parent through the composite FK.
            create: DEFAULT_PIPELINE.stages.map((stage, index) => ({
              ...stage,
              position: index + 1,
            })),
          },
        },
      });
    }

    return { organizationId: org.id, adminId };
  });
}
