import { createPrismaClient, type PrismaClient } from '../../prisma/seed/prisma-client';
import { seedPermissions } from '../../prisma/seed/seed-organization';
import { assertTestDatabase } from '../setup/test-database';

// A client for arranging and inspecting rows directly (unscoped on purpose: tests must not depend
// on the code under test to set up their data).
export function createTestPrisma(): PrismaClient {
  return createPrismaClient(assertTestDatabase(process.env.TEST_DATABASE_URL));
}

// Wipes every tenant and the permission catalogue, then restores the catalogue.
// assertTestDatabase in createTestPrisma is what makes this safe to run.
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "Organization", "Permission" RESTART IDENTITY CASCADE');
  await seedPermissions(prisma);
}
