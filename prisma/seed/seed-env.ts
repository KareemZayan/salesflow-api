import { z } from 'zod';
import {
  isRejectedPassword,
  passwordLengthProblem,
} from '../../src/common/policies/password-policy';
import { ORGANIZATION_SLUG_PATTERN } from '../../src/common/policies/organization-policy';

const seedEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SEED_DEMO_DATA: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SEED_ORG_NAME: z.string().min(1).default('Demo Organization'),
    SEED_ORG_SLUG: z
      .string()
      .regex(ORGANIZATION_SLUG_PATTERN, 'must be a lowercase slug')
      .default('demo'),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string(),
  })
  .superRefine((env, ctx) => {
    // Same length rules as the API. The blocklist (placeholder) only applies in production, so the
    // committed .env.example still works for local development.
    const lengthProblem = passwordLengthProblem(env.SEED_ADMIN_PASSWORD);
    if (lengthProblem) {
      ctx.addIssue({ code: 'custom', path: ['SEED_ADMIN_PASSWORD'], message: lengthProblem });
    }
    if (env.NODE_ENV !== 'production') return;
    if (isRejectedPassword(env.SEED_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEED_ADMIN_PASSWORD'],
        message: 'the placeholder password is not allowed when NODE_ENV=production',
      });
    }
    if (env.SEED_DEMO_DATA) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEED_DEMO_DATA'],
        message: 'demo data is not allowed when NODE_ENV=production',
      });
    }
  });

export type SeedEnv = z.infer<typeof seedEnvSchema>;

// Fail fast: a bad seed configuration must stop the container before the app starts.
export function parseSeedEnv(raw: Record<string, string | undefined>): SeedEnv {
  const result = seedEnvSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid seed configuration: ${details}`);
  }
  return result.data;
}
