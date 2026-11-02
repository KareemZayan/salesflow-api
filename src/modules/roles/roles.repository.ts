import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { buildPaginated, toOrderBy, toSkipTake } from '../../common/utils/pagination.util';
import { Prisma } from '../../generated/prisma/client';
import { acquireOrgLock } from '../../infrastructure/prisma/org-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';
import { ROLE_SORT_FIELDS } from './roles.constants';

// Permission keys and the user count come with the role in ONE query (`_count`), so a list of N
// roles is never N+1.
const roleSelect = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleSelect;

export type RoleRecord = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;
export type RolesTx = TenantTransactionClient;

@Injectable()
export class RolesRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Every role write runs under the organization lock: the same lock user writes take, so "delete
  // a role nobody holds" cannot interleave with "assign that role to a user".
  withOrgLock<T>(organizationId: string, work: (tx: RolesTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await acquireOrgLock(tx, organizationId);
      return work(tx);
    });
  }

  async findPage(query: ListRolesQueryDto): Promise<PaginatedResponseDto<RoleRecord>> {
    const [rows, total] = await Promise.all([
      this.prisma.role.findMany({
        select: roleSelect,
        orderBy: [toOrderBy(query, ROLE_SORT_FIELDS, 'name'), { id: 'asc' }],
        ...toSkipTake(query),
      }),
      this.prisma.role.count(),
    ]);
    return buildPaginated(rows, total, query);
  }

  findById(id: string, db: RolesTx = this.prisma): Promise<RoleRecord | null> {
    return db.role.findUnique({ where: { id }, select: roleSelect });
  }

  // Case-insensitive: "support" and "Support" are the same role to a human.
  findByNameIgnoringCase(
    name: string,
    excludeId: string | undefined,
    db: RolesTx,
  ): Promise<{ id: string } | null> {
    return db.role.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, id: { not: excludeId } },
      select: { id: true },
    });
  }

  // Permission is a global catalogue (not a tenant model), so this is not org-scoped.
  findPermissionsByKeys(keys: string[], db: RolesTx): Promise<{ id: string; key: string }[]> {
    return db.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
  }

  listPermissions(): Promise<{ key: string; description: string }[]> {
    return this.prisma.permission.findMany({
      select: { key: true, description: true },
      orderBy: { key: 'asc' },
    });
  }

  create(
    data: { organizationId: string; name: string; description?: string; permissionIds: string[] },
    db: RolesTx,
  ): Promise<RoleRecord> {
    const { permissionIds, ...role } = data;
    return db.role.create({
      data: {
        ...role,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
      select: roleSelect,
    });
  }

  async update(
    id: string,
    data: { name?: string; description?: string },
    db: RolesTx,
  ): Promise<void> {
    await db.role.update({ where: { id }, data });
  }

  // Full replace. The caller already proved (scoped lookup, same transaction) that the role is in
  // this organization; RolePermission itself has no organizationId.
  async replacePermissions(roleId: string, permissionIds: string[], db: RolesTx): Promise<void> {
    await db.rolePermission.deleteMany({ where: { roleId } });
    await db.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
    });
  }

  // Counts inactive users too: they keep their role and may be reactivated.
  countUsers(roleId: string, db: RolesTx): Promise<number> {
    return db.user.count({ where: { roleId } });
  }

  async delete(id: string, db: RolesTx): Promise<void> {
    await db.role.delete({ where: { id } });
  }
}
