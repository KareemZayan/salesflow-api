import type { PrismaClient } from '../../prisma/seed/prisma-client';

let sequence = 0;

interface Owned {
  organizationId: string;
  ownerId: string;
}

// Rows are created with the unscoped client on purpose: tests must not depend on the module under
// test to arrange their data.
export function createCompany(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  overrides: { name?: string; domain?: string; industry?: string; deletedAt?: Date } = {},
) {
  return prisma.company.create({
    data: { organizationId, ownerId, name: `Company ${++sequence}`, ...overrides },
  });
}

export function createContact(
  prisma: PrismaClient,
  { organizationId, ownerId }: Owned,
  overrides: { companyId?: string; firstName?: string; email?: string; deletedAt?: Date } = {},
) {
  return prisma.contact.create({
    data: {
      organizationId,
      ownerId,
      firstName: 'Contact',
      lastName: `No${++sequence}`,
      ...overrides,
    },
  });
}
