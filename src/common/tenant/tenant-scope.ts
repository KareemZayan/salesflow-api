import { SOFT_DELETE_MODELS, TENANT_MODELS } from './tenant-models';

export class MissingTenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(`No tenant context for ${model}.${operation}; refusing to run an unscoped query`);
  }
}

export class TenantScopeViolationError extends Error {}

export interface TenantScope {
  organizationId: string | undefined;
  includeDeleted: boolean;
}

type Args = Record<string, unknown>;

const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_DATA_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

// Pure core of the tenant extension: returns the args to run, or throws. Kept free of Prisma so
// it can be unit-tested exhaustively; the integration tests prove it against a real database.
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  scope: TenantScope,
): Args {
  const input = (args ?? {}) as Args;
  if (!TENANT_MODELS.has(model)) return input;

  const { organizationId } = scope;
  if (!organizationId) throw new MissingTenantContextError(model, operation);

  const softDelete = SOFT_DELETE_MODELS.has(model) && !scope.includeDeleted;
  const withFilter = (where: unknown): Args => ({
    ...(where as Args | undefined),
    organizationId,
    ...(softDelete && { deletedAt: null }),
  });

  if (FILTERED_OPERATIONS.has(operation)) {
    if (UPDATE_DATA_OPERATIONS.has(operation))
      assertNoOrganizationWrite(input.data, model, operation);
    return { ...input, where: withFilter(input.where) };
  }
  if (CREATE_OPERATIONS.has(operation)) {
    return { ...input, data: withOrganization(input.data, organizationId) };
  }
  if (operation === 'upsert') {
    assertNoOrganizationWrite(input.update, model, operation);
    return {
      ...input,
      where: withFilter(input.where),
      create: withOrganization(input.create, organizationId),
    };
  }
  // Fail closed: an operation we have not reasoned about must not slip through unscoped.
  throw new TenantScopeViolationError(
    `Unsupported operation ${model}.${operation} on a tenant model`,
  );
}

// Overwrites rather than trusts a caller-supplied organizationId.
function withOrganization(data: unknown, organizationId: string): unknown {
  return Array.isArray(data)
    ? data.map((row) => ({ ...row, organizationId }))
    : { ...(data as Args), organizationId };
}

// A record never moves between tenants.
function assertNoOrganizationWrite(data: unknown, model: string, operation: string): void {
  const keys = Object.keys((data as Args | undefined) ?? {});
  if (keys.includes('organizationId') || keys.includes('organization')) {
    throw new TenantScopeViolationError(`${model}.${operation} must not write organizationId`);
  }
}
