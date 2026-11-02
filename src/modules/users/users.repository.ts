import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_ROLE_NAME } from '../../common/constants/roles';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { buildPaginated, toOrderBy, toSkipTake } from '../../common/utils/pagination.util';
import { Prisma } from '../../generated/prisma/client';
import { acquireOrgLock } from '../../infrastructure/prisma/org-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { USER_SORT_FIELDS } from './users.constants';

// An explicit select: passwordHash is never loaded, so it cannot leak even if a DTO is careless.
const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  isActive: true,
  mustChangePassword: true,
  managerId: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof userSelect }>;

export type NewUserData = Pick<
  Prisma.UserUncheckedCreateInput,
  'organizationId' | 'email' | 'firstName' | 'lastName' | 'roleId' | 'managerId' | 'passwordHash'
>;

export type UserChanges = Pick<
  Prisma.UserUncheckedUpdateInput,
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'roleId'
  | 'managerId'
  | 'isActive'
  | 'passwordHash'
  | 'mustChangePassword'
>;

export type UsersTx = TenantTransactionClient;

export interface RoleRef {
  id: string;
  name: string;
  permissionKeys: string[];
}

@Injectable()
export class UsersRepository {
  constructor(@Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient) {}

  // Every write that touches isActive, roleId or managerId runs under the organization lock, so the
  // rules that look at other rows (last admin, manager cycle, active reports) cannot be raced.
  withOrgLock<T>(organizationId: string, work: (tx: UsersTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await acquireOrgLock(tx, organizationId);
      return work(tx);
    });
  }

  findById(id: string, db: UsersTx = this.prisma): Promise<UserRecord | null> {
    return db.user.findUnique({ where: { id }, select: userSelect });
  }

  async findPage(query: ListUsersQueryDto): Promise<PaginatedResponseDto<UserRecord>> {
    const { search, roleId, managerId, isActive } = query;
    const where: Prisma.UserWhereInput = {
      roleId,
      managerId,
      isActive,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: userSelect,
        // `id` as a tiebreaker keeps pages stable when the sort column has duplicates.
        orderBy: [toOrderBy(query, USER_SORT_FIELDS, 'createdAt'), { id: 'asc' }],
        ...toSkipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return buildPaginated(rows, total, query);
  }

  // Permission keys come along so the service can apply the escalation rule without a second query.
  async findRole(roleId: string, db: UsersTx): Promise<RoleRef | null> {
    const role = await db.role.findUnique({
      where: { id: roleId },
      select: {
        id: true,
        name: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
    if (!role) return null;
    return {
      id: role.id,
      name: role.name,
      permissionKeys: role.permissions.map(({ permission }) => permission.key),
    };
  }

  create(data: NewUserData, db: UsersTx): Promise<UserRecord> {
    return db.user.create({ data: { ...data, mustChangePassword: true }, select: userSelect });
  }

  update(id: string, data: UserChanges, db: UsersTx): Promise<UserRecord> {
    return db.user.update({ where: { id }, data, select: userSelect });
  }

  countOtherActiveAdmins(excludeUserId: string, db: UsersTx): Promise<number> {
    return db.user.count({
      where: { isActive: true, id: { not: excludeUserId }, role: { name: ADMIN_ROLE_NAME } },
    });
  }

  countActiveReports(managerId: string, db: UsersTx): Promise<number> {
    return db.user.count({ where: { managerId, isActive: true } });
  }
}
