// Injection token for the tenant-scoped client. Feature repositories inject this one;
// the raw `PrismaService` (unscoped) is reserved for auth, seed, jobs bootstrap and reports (ESLint-enforced).
export const PRISMA_TENANT = 'PRISMA_TENANT';
