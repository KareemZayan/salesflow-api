import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ADMIN_ROLE_NAME, SYSTEM_ROLE_NAMES } from '../../common/constants/roles';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertMayGrant } from '../../common/utils/permission-escalation.util';
import { isUniqueViolation } from '../../common/utils/prisma-error.util';
import { CreateRoleDto } from './dto/create-role.dto';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';
import { PermissionResponseDto, RoleResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleRecord, RolesRepository, RolesTx } from './roles.repository';

type RoleEvent = 'role.created' | 'role.updated' | 'role.deleted';

const keysOf = (role: RoleRecord): string[] => role.permissions.map((p) => p.permission.key);

const toDto = (role: RoleRecord): RoleResponseDto => ({
  id: role.id,
  name: role.name,
  description: role.description,
  isSystem: role.isSystem,
  permissionKeys: keysOf(role).sort(),
  userCount: role._count.users,
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((key) => b.includes(key));

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly repository: RolesRepository) {}

  async list(query: ListRolesQueryDto): Promise<PaginatedResponseDto<RoleResponseDto>> {
    const page = await this.repository.findPage(query);
    return { ...page, data: page.data.map(toDto) };
  }

  async get(id: string): Promise<RoleResponseDto> {
    const role = await this.repository.findById(id);
    if (!role) throw this.notFound();
    return toDto(role);
  }

  listPermissions(): Promise<PermissionResponseDto[]> {
    return this.repository.listPermissions();
  }

  async create(actor: AuthenticatedUser, dto: CreateRoleDto): Promise<RoleResponseDto> {
    const role = await this.guardName(() =>
      this.repository.withOrgLock(actor.organizationId, async (tx) => {
        await this.assertNameAllowed(dto.name, undefined, tx);
        assertMayGrant(actor, dto.permissionKeys);
        const permissionIds = await this.resolvePermissionIds(dto.permissionKeys, tx);
        return this.repository.create(
          {
            organizationId: actor.organizationId,
            name: dto.name,
            description: dto.description,
            permissionIds,
          },
          tx,
        );
      }),
    );
    this.record('role.created', actor, role.id);
    return toDto(role);
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateRoleDto): Promise<RoleResponseDto> {
    const role = await this.guardName(() =>
      this.repository.withOrgLock(actor.organizationId, async (tx) => {
        const current = await this.requireRole(id, tx);
        const currentKeys = keysOf(current);
        const nameChanged = dto.name !== undefined && dto.name !== current.name;
        const descriptionChanged =
          dto.description !== undefined && dto.description !== current.description;
        const permissionsChanged =
          dto.permissionKeys !== undefined && !sameSet(dto.permissionKeys, currentKeys);

        // System roles are identified by the isSystem flag, never by a name someone could edit.
        // ADMIN is frozen entirely: an org must always have a role that can do everything.
        if (current.isSystem && nameChanged) throw this.immutable('System roles cannot be renamed');
        if (this.isAdminRole(current) && (descriptionChanged || permissionsChanged)) {
          throw this.immutable('The ADMIN role cannot be changed');
        }

        // Editing a role means being able to hand out everything it has and will have.
        assertMayGrant(actor, [...currentKeys, ...(dto.permissionKeys ?? [])]);

        if (nameChanged) await this.assertNameAllowed(dto.name as string, id, tx);
        if (nameChanged || descriptionChanged) {
          await this.repository.update(id, { name: dto.name, description: dto.description }, tx);
        }
        if (permissionsChanged) {
          const permissionIds = await this.resolvePermissionIds(dto.permissionKeys ?? [], tx);
          await this.repository.replacePermissions(id, permissionIds, tx);
        }
        return this.requireRole(id, tx);
      }),
    );
    this.record('role.updated', actor, id);
    return toDto(role);
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.repository.withOrgLock(actor.organizationId, async (tx) => {
      const role = await this.requireRole(id, tx);
      if (role.isSystem) throw this.immutable('System roles cannot be deleted');
      assertMayGrant(actor, keysOf(role));
      // Under the org lock, so a concurrent "assign this role to a user" cannot slip in between.
      if ((await this.repository.countUsers(id, tx)) > 0) {
        throw new DomainException(
          ERROR_CODES.ROLE_IN_USE,
          'Reassign the users holding this role (inactive ones included) before deleting it',
          HttpStatus.CONFLICT,
        );
      }
      await this.repository.delete(id, tx);
    });
    this.record('role.deleted', actor, id);
  }

  private isAdminRole(role: RoleRecord): boolean {
    return role.isSystem && role.name === ADMIN_ROLE_NAME;
  }

  // Reserved names block impersonating a system role ("admin", "Sales_Rep"); the duplicate check
  // is case-insensitive and runs under the lock, with the unique index as the final backstop.
  private async assertNameAllowed(
    name: string,
    excludeId: string | undefined,
    tx: RolesTx,
  ): Promise<void> {
    if (SYSTEM_ROLE_NAMES.includes(name.toUpperCase())) {
      throw new DomainException(
        ERROR_CODES.ROLE_NAME_RESERVED,
        'This role name is reserved for a system role',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.repository.findByNameIgnoringCase(name, excludeId, tx)) {
      throw this.nameTaken();
    }
  }

  private async resolvePermissionIds(keys: string[], tx: RolesTx): Promise<string[]> {
    const unique = [...new Set(keys)];
    const found = await this.repository.findPermissionsByKeys(unique, tx);
    if (found.length !== unique.length) {
      const known = new Set(found.map(({ key }) => key));
      throw new DomainException(
        ERROR_CODES.INVALID_PERMISSION,
        'Unknown permission key',
        HttpStatus.BAD_REQUEST,
        { unknown: unique.filter((key) => !known.has(key)) },
      );
    }
    return found.map(({ id }) => id);
  }

  private async requireRole(id: string, tx: RolesTx): Promise<RoleRecord> {
    const role = await this.repository.findById(id, tx);
    if (!role) throw this.notFound();
    return role;
  }

  private async guardName<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) throw this.nameTaken();
      throw error;
    }
  }

  private record(event: RoleEvent, actor: AuthenticatedUser, roleId: string): void {
    this.logger.log({
      event,
      organizationId: actor.organizationId,
      actorId: actor.userId,
      roleId,
    });
  }

  private notFound(): DomainException {
    return new DomainException(
      ERROR_CODES.RESOURCE_NOT_FOUND,
      'Role not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private nameTaken(): DomainException {
    return new DomainException(
      ERROR_CODES.ROLE_NAME_ALREADY_EXISTS,
      'A role with this name already exists',
      HttpStatus.CONFLICT,
    );
  }

  private immutable(message: string): DomainException {
    return new DomainException(ERROR_CODES.SYSTEM_ROLE_IMMUTABLE, message, HttpStatus.FORBIDDEN);
  }
}
