import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Only these places may bypass tenant scoping: the unscoped PrismaService and raw SQL.
const UNSCOPED_ALLOWED = [
  'src/modules/auth/**',
  'src/modules/reports/**',
  'src/jobs/bootstrap/**',
  'src/infrastructure/**',
  'prisma/seed/**',
  'test/**',
  '**/*.spec.ts',
];

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'src/generated/', '*.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/prisma/prisma.service'],
              message:
                'PrismaService is the unscoped client. Inject PRISMA_TENANT instead; the unscoped client is only for auth, seed, jobs bootstrap and reports.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^[$](query|execute)Raw(Unsafe)?$/]',
          message:
            'Raw SQL bypasses tenant scoping. It is only allowed in auth, seed, jobs bootstrap and reports.',
        },
      ],
    },
  },
  {
    files: UNSCOPED_ALLOWED,
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
);
