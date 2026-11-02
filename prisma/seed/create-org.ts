import { CliError, createOrganization } from './create-org-command';
import { ORG_ADMIN_PASSWORD_ENV, parseCreateOrgArgs, USAGE, UsageError } from './create-org-args';
import { createPrismaClient } from './prisma-client';

// Platform operator tool: creates an organization and its first admin (see ADR 0006).
//
// SECURITY: the generated password is written to stdout, on purpose NOT through the pino logger.
// Do not run this where stdout is shipped to shared logs (CI logs, log aggregation). Run it in an
// interactive shell, or capture stdout yourself and store it in a secret manager.
async function main(): Promise<void> {
  const args = parseCreateOrgArgs(process.argv.slice(2), process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new CliError('DATABASE_URL is not set');

  const prisma = createPrismaClient(databaseUrl);
  try {
    const result = await createOrganization(prisma, args);
    const out = (line: string) => process.stdout.write(`${line}\n`);
    if (result.status === 'exists') {
      out(
        `Organization "${args.slug}" already exists with admin ${args.adminEmail}; nothing changed.`,
      );
      return;
    }
    out(`Organization "${args.slug}" created (id ${result.organizationId}).`);
    out(`Admin: ${args.adminEmail}`);
    if (result.generatedPassword) {
      out(`Temporary password (shown once): ${result.generatedPassword}`);
    } else {
      out(`Password: taken from ${ORG_ADMIN_PASSWORD_ENV} (not shown).`);
    }
    out('The admin must change the password at first sign-in.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[org:create] ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exit(1);
});
