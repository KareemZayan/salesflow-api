import { randomBytes } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client';
import type { CreateOrgArgs } from './create-org-args';
import { ROLE_NAMES } from './permissions';
import type { PrismaClient } from './prisma-client';
import { seedOrganization } from './seed-organization';

// A problem the operator can fix (exit code 1, message shown as is).
export class CliError extends Error {}

export type CreateOrgResult =
  | { status: 'created'; organizationId: string; adminId: string; generatedPassword?: string }
  | { status: 'exists'; organizationId: string };

// Idempotent on the slug. Everything is created by the shared seedOrganization (one transaction:
// org, roles with permissions, first admin, default pipeline), so a failure leaves nothing behind.
export async function createOrganization(
  prisma: PrismaClient,
  args: CreateOrgArgs,
): Promise<CreateOrgResult> {
  const existing = await findExisting(prisma, args);
  if (existing) return existing;

  const generatedPassword = args.password ? undefined : generatePassword();
  try {
    const { organizationId, adminId } = await seedOrganization(prisma, {
      name: args.name,
      slug: args.slug,
      defaultCurrency: args.currency,
      admin: {
        email: args.adminEmail,
        password: args.password ?? (generatedPassword as string),
        firstName: args.adminFirstName,
        lastName: args.adminLastName,
        // A password the operator generated or typed into a shell is a one-time secret.
        mustChangePassword: true,
      },
    });
    return { status: 'created', organizationId, adminId, generatedPassword };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    // A parallel run won the race for the slug or the email. Same request => nothing to do.
    const winner = await findExisting(prisma, args);
    if (winner) return winner;
    throw new CliError(
      `"${args.slug}" or "${args.adminEmail}" was created concurrently by a different request`,
    );
  }
}

// 'exists' only when the organization is there AND its ADMIN is the requested user. Anything else
// is a conflict the operator must resolve; silently reporting success would hide it.
async function findExisting(
  prisma: PrismaClient,
  args: CreateOrgArgs,
): Promise<CreateOrgResult | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: args.slug },
    select: { id: true },
  });
  const user = await prisma.user.findUnique({
    where: { email: args.adminEmail },
    select: { organizationId: true, role: { select: { name: true } } },
  });

  if (!org) {
    if (user) {
      throw new CliError(`The admin email ${args.adminEmail} belongs to another organization`);
    }
    return null;
  }
  if (user?.organizationId === org.id && user.role.name === ROLE_NAMES.ADMIN) {
    return { status: 'exists', organizationId: org.id };
  }
  throw new CliError(
    `Organization "${args.slug}" already exists with a different admin. ` +
      'Add users to it through the API instead.',
  );
}

// 24 URL-safe characters (144 bits): satisfies the password policy by construction.
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}
