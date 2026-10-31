import { seedDemoData } from './demo-data';
import { createPrismaClient } from './prisma-client';
import { parseSeedEnv } from './seed-env';
import { seedOrganization, seedPermissions } from './seed-organization';

// Core seed, always idempotent: permissions, first org (roles, admin, default pipeline).
// Demo data only when SEED_DEMO_DATA=true. Run by docker/entrypoint.sh on every start.
async function main(): Promise<void> {
  const env = parseSeedEnv(process.env);
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await seedPermissions(prisma);
    const { organizationId } = await seedOrganization(prisma, {
      name: env.SEED_ORG_NAME,
      slug: env.SEED_ORG_SLUG,
      admin: { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD },
    });
    console.log(`[seed] core data ready for organization "${env.SEED_ORG_SLUG}"`);

    if (env.SEED_DEMO_DATA) {
      const created = await seedDemoData(prisma, {
        organizationId,
        password: env.SEED_ADMIN_PASSWORD,
      });
      console.log(`[seed] demo data ${created ? 'created' : 'already present, skipped'}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
