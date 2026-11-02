import { parseArgs } from 'node:util';
import { z } from 'zod';
import { isCurrencyCode } from '../../src/common/policies/currency-policy';
import {
  DEFAULT_CURRENCY,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  ORGANIZATION_SLUG_PATTERN,
} from '../../src/common/policies/organization-policy';
import { findPasswordProblem } from '../../src/common/policies/password-policy';

export const ORG_ADMIN_PASSWORD_ENV = 'ORG_ADMIN_PASSWORD';

export const USAGE = `Usage: pnpm org:create --name <name> --slug <slug> --admin-email <email>
         [--admin-first-name <name>] [--admin-last-name <name>] [--currency <ISO 4217>]

The first admin gets a generated password, printed once to stdout. To choose it yourself, set
${ORG_ADMIN_PASSWORD_ENV} in the environment (never pass a password as an argument).`;

// Thrown for any mistake in the command line, so the entry point can print the usage text.
export class UsageError extends Error {}

const personName = (label: string) => z.string().trim().min(1, `${label} is required`).max(100);

const argsSchema = z.object({
  name: z
    .string({ error: '--name is required' })
    .trim()
    .min(1, '--name is required')
    .max(ORGANIZATION_NAME_MAX_LENGTH),
  slug: z
    .string({ error: '--slug is required' })
    .max(ORGANIZATION_SLUG_MAX_LENGTH)
    .regex(ORGANIZATION_SLUG_PATTERN, 'must be a lowercase slug such as "acme-eu"'),
  adminEmail: z
    .string({ error: '--admin-email is required' })
    .trim()
    .toLowerCase()
    .email()
    .max(254),
  adminFirstName: personName('--admin-first-name').default('Admin'),
  adminLastName: personName('--admin-last-name').default('User'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isCurrencyCode, 'must be a valid ISO 4217 code such as USD')
    .default(DEFAULT_CURRENCY),
  // Only from the environment. Undefined means "generate one".
  password: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      const problem = value === undefined ? null : findPasswordProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
});

export type CreateOrgArgs = z.infer<typeof argsSchema>;

// Pure: argv and env in, validated input out. Error messages never contain the password.
export function parseCreateOrgArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): CreateOrgArgs {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        name: { type: 'string' },
        slug: { type: 'string' },
        'admin-email': { type: 'string' },
        'admin-first-name': { type: 'string' },
        'admin-last-name': { type: 'string' },
        currency: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const result = argsSchema.safeParse({
    name: values.name,
    slug: values.slug,
    adminEmail: values['admin-email'],
    adminFirstName: values['admin-first-name'],
    adminLastName: values['admin-last-name'],
    currency: values.currency,
    password: env[ORG_ADMIN_PASSWORD_ENV] || undefined,
  });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field = issue.path[0] === 'password' ? ORG_ADMIN_PASSWORD_ENV : String(issue.path[0]);
        return `${field}: ${issue.message}`;
      })
      .join('; ');
    throw new UsageError(`Invalid arguments: ${details}`);
  }
  return result.data;
}
