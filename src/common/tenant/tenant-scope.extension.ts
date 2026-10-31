import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { scopeArgs, TenantScope } from './tenant-scope';

type SoftDeletable = {
  update(args: unknown): Promise<unknown>;
  updateMany(args: unknown): Promise<unknown>;
};

// Soft-deletable models never hard delete through the scoped client: `delete`/`deleteMany`
// become an update of `deletedAt`, routed back through the extension so scoping still applies and
// the call stays inside the caller's transaction. A real DELETE needs the unscoped client.
const softDeleteMethods = {
  delete<T, A>(
    this: T,
    args: Prisma.Exact<A, Prisma.Args<T, 'delete'>>,
  ): Prisma.PrismaPromise<Prisma.Result<T, A, 'delete'>> {
    const model = Prisma.getExtensionContext(this) as unknown as SoftDeletable;
    return model.update({
      where: (args as { where: unknown }).where,
      data: { deletedAt: new Date() },
    }) as Prisma.PrismaPromise<Prisma.Result<T, A, 'delete'>>;
  },
  deleteMany<T, A>(
    this: T,
    args?: Prisma.Exact<A, Prisma.Args<T, 'deleteMany'>>,
  ): Prisma.PrismaPromise<Prisma.Result<T, A, 'deleteMany'>> {
    const model = Prisma.getExtensionContext(this) as unknown as SoftDeletable;
    return model.updateMany({
      where: (args as { where?: unknown } | undefined)?.where,
      data: { deletedAt: new Date() },
    }) as Prisma.PrismaPromise<Prisma.Result<T, A, 'deleteMany'>>;
  },
};

// Pattern: client extension (Decorator). `scope` is read on every call, so one client instance
// serves all requests; the tenant is whatever the current async context says.
export function createTenantClient(prisma: PrismaClient, scope: TenantScope) {
  return prisma.$extends({
    name: 'tenant-scope',
    model: {
      company: softDeleteMethods,
      contact: softDeleteMethods,
      lead: softDeleteMethods,
      deal: softDeleteMethods,
    },
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args, scope));
        },
      },
    },
  });
}

export type TenantPrismaClient = ReturnType<typeof createTenantClient>;
