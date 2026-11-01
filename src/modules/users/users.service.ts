import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ADMIN_ROLE_NAME } from '../../common/constants/roles';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { isUniqueViolation } from '../../common/utils/prisma-error.util';
import { PasswordService } from '../auth/password.service';
import { SessionRevoker } from '../auth/session-revoker.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { MAX_MANAGER_DEPTH } from './users.constants';
import { UserChanges, UserRecord, UsersRepository, UsersTx } from './users.repository';

// Structured log events stand in for the audit trail until Phase 13. They carry ids only, never
// credentials.
type UserEvent =
  | 'user.created'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.role_changed'
  | 'user.password_reset';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repository: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionRevoker,
  ) {}

  list(query: ListUsersQueryDto): Promise<PaginatedResponseDto<UserRecord>> {
    return this.repository.findPage(query);
  }

  async get(id: string): Promise<UserRecord> {
    const user = await this.repository.findById(id);
    if (!user) throw this.notFound();
    return user;
  }

  async create(actor: AuthenticatedUser, dto: CreateUserDto): Promise<UserRecord> {
    this.passwords.assertAcceptable(dto.temporaryPassword);
    const passwordHash = await this.passwords.hash(dto.temporaryPassword);

    const user = await this.guardEmail(() =>
      this.repository.withOrgLock(actor.organizationId, async (tx) => {
        const role = await this.requireRole(dto.roleId, tx);
        this.assertAdminRoleAllowed(actor, role.name);
        if (dto.managerId) await this.assertManagerAssignable(dto.managerId, undefined, tx);
        return this.repository.create(
          {
            organizationId: actor.organizationId,
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            roleId: role.id,
            managerId: dto.managerId,
            passwordHash,
          },
          tx,
        );
      }),
    );
    this.record('user.created', actor, user.id);
    return user;
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateUserDto): Promise<UserRecord> {
    let roleChange: { from: string; to: string } | undefined;
    const user = await this.guardEmail(() =>
      this.repository.withOrgLock(actor.organizationId, async (tx) => {
        const target = await this.requireUser(id, tx);
        this.assertAdminRoleAllowed(actor, target.role.name);

        const changes: UserChanges = {
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
        };

        if (dto.roleId !== undefined && dto.roleId !== target.role.id) {
          if (target.id === actor.userId) {
            throw this.forbidden(
              ERROR_CODES.CANNOT_CHANGE_OWN_ROLE,
              'You cannot change your own role',
            );
          }
          const role = await this.requireRole(dto.roleId, tx);
          this.assertAdminRoleAllowed(actor, role.name);
          if (target.role.name === ADMIN_ROLE_NAME && role.name !== ADMIN_ROLE_NAME) {
            await this.assertAdminCanBeRemoved(target, tx);
          }
          changes.roleId = role.id;
          roleChange = { from: target.role.id, to: role.id };
        }

        if (dto.managerId !== undefined && dto.managerId !== target.managerId) {
          if (dto.managerId !== null) await this.assertManagerAssignable(dto.managerId, id, tx);
          changes.managerId = dto.managerId;
        }

        return this.repository.update(id, changes, tx);
      }),
    );
    if (roleChange) this.record('user.role_changed', actor, id, roleChange);
    return user;
  }

  async deactivate(actor: AuthenticatedUser, id: string): Promise<UserRecord> {
    if (id === actor.userId) {
      throw this.forbidden(
        ERROR_CODES.CANNOT_DEACTIVATE_SELF,
        'You cannot deactivate your own account',
      );
    }
    const { user, changed } = await this.repository.withOrgLock(
      actor.organizationId,
      async (tx) => {
        const target = await this.requireUser(id, tx);
        this.assertAdminRoleAllowed(actor, target.role.name);
        if (!target.isActive) return { user: target, changed: false };

        if (target.role.name === ADMIN_ROLE_NAME) await this.assertAdminCanBeRemoved(target, tx);
        if ((await this.repository.countActiveReports(id, tx)) > 0) {
          throw new DomainException(
            ERROR_CODES.USER_HAS_ACTIVE_REPORTS,
            "Reassign this user's active direct reports before deactivating them",
            HttpStatus.CONFLICT,
          );
        }
        const updated = await this.repository.update(id, { isActive: false }, tx);
        // Same transaction: a deactivated user never keeps a working refresh token.
        await this.sessions.revokeAllForUser(tx, id, new Date());
        return { user: updated, changed: true };
      },
    );
    if (changed) this.record('user.deactivated', actor, id);
    return user;
  }

  async reactivate(actor: AuthenticatedUser, id: string): Promise<UserRecord> {
    const { user, changed } = await this.repository.withOrgLock(
      actor.organizationId,
      async (tx) => {
        const target = await this.requireUser(id, tx);
        this.assertAdminRoleAllowed(actor, target.role.name);
        if (target.isActive) return { user: target, changed: false };

        // An active user must not sit under an inactive manager. The admin fixes the manager first
        // (PATCH managerId), then reactivates.
        if (target.managerId) {
          const manager = await this.repository.findById(target.managerId, tx);
          if (!manager?.isActive) {
            throw this.invalidManager(
              'The manager of this user is inactive; assign an active manager (or none) first',
              HttpStatus.CONFLICT,
            );
          }
        }
        return { user: await this.repository.update(id, { isActive: true }, tx), changed: true };
      },
    );
    if (changed) this.record('user.reactivated', actor, id);
    return user;
  }

  async resetPassword(
    actor: AuthenticatedUser,
    id: string,
    { temporaryPassword }: ResetPasswordDto,
  ): Promise<void> {
    if (id === actor.userId) {
      throw this.forbidden(
        ERROR_CODES.CANNOT_RESET_OWN_PASSWORD,
        'Use change-password to change your own password',
      );
    }
    this.passwords.assertAcceptable(temporaryPassword);
    // Hashing is slow on purpose; do it before taking the lock.
    const passwordHash = await this.passwords.hash(temporaryPassword);

    await this.repository.withOrgLock(actor.organizationId, async (tx) => {
      const target = await this.requireUser(id, tx);
      this.assertAdminRoleAllowed(actor, target.role.name);
      await this.repository.update(id, { passwordHash, mustChangePassword: true }, tx);
      await this.sessions.revokeAllForUser(tx, id, new Date());
    });
    this.record('user.password_reset', actor, id);
  }

  // Privilege escalation guard: only an ADMIN may touch an ADMIN account or hand out the ADMIN
  // role, so a custom role holding users:update cannot promote itself or take over an admin.
  private assertAdminRoleAllowed(actor: AuthenticatedUser, roleName: string): void {
    if (roleName === ADMIN_ROLE_NAME && actor.role !== ADMIN_ROLE_NAME) {
      throw this.forbidden(
        ERROR_CODES.ADMIN_REQUIRED,
        'Only an administrator can manage administrator accounts',
      );
    }
  }

  // Call only for an ADMIN that is about to stop being one (deactivation or demotion). Must run
  // under the organization lock, otherwise two admins removing each other could both pass.
  private async assertAdminCanBeRemoved(target: UserRecord, tx: UsersTx): Promise<void> {
    if (!target.isActive) return;
    if ((await this.repository.countOtherActiveAdmins(target.id, tx)) === 0) {
      throw new DomainException(
        ERROR_CODES.LAST_ADMIN_REQUIRED,
        'The organization must keep at least one active administrator',
        HttpStatus.CONFLICT,
      );
    }
  }

  // The manager must exist in this organization (the scoped client hides other tenants), be
  // active, and not already be below `userId` in the hierarchy.
  private async assertManagerAssignable(
    managerId: string,
    userId: string | undefined,
    tx: UsersTx,
  ): Promise<void> {
    if (managerId === userId) throw this.invalidManager('A user cannot be their own manager');
    const manager = await this.repository.findById(managerId, tx);
    if (!manager) throw this.invalidManager('Manager not found');
    if (!manager.isActive) throw this.invalidManager('The manager is inactive');
    if (!userId) return;

    const visited = new Set<string>([managerId]);
    let ancestorId = manager.managerId;
    while (ancestorId && visited.size <= MAX_MANAGER_DEPTH) {
      if (ancestorId === userId) {
        throw this.invalidManager('This assignment would create a management cycle');
      }
      if (visited.has(ancestorId)) return;
      visited.add(ancestorId);
      ancestorId = (await this.repository.findById(ancestorId, tx))?.managerId ?? null;
    }
  }

  private async requireUser(id: string, tx: UsersTx): Promise<UserRecord> {
    const user = await this.repository.findById(id, tx);
    if (!user) throw this.notFound();
    return user;
  }

  private async requireRole(roleId: string, tx: UsersTx): Promise<{ id: string; name: string }> {
    const role = await this.repository.findRole(roleId, tx);
    if (!role) {
      throw new DomainException(ERROR_CODES.INVALID_ROLE, 'Role not found', HttpStatus.BAD_REQUEST);
    }
    return role;
  }

  // Email is globally unique, so the database is the only place that can decide (the scoped client
  // cannot see other organizations). The message deliberately never says where the clash is.
  private async guardEmail<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new DomainException(
        ERROR_CODES.EMAIL_ALREADY_EXISTS,
        'A user with this email already exists',
        HttpStatus.CONFLICT,
      );
    }
  }

  private record(
    event: UserEvent,
    actor: AuthenticatedUser,
    targetId: string,
    extra?: Record<string, string>,
  ): void {
    this.logger.log({
      event,
      organizationId: actor.organizationId,
      actorId: actor.userId,
      targetId,
      ...extra,
    });
  }

  private notFound(): DomainException {
    return new DomainException(
      ERROR_CODES.RESOURCE_NOT_FOUND,
      'User not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private forbidden(code: string, message: string): DomainException {
    return new DomainException(code, message, HttpStatus.FORBIDDEN);
  }

  private invalidManager(message: string, status = HttpStatus.BAD_REQUEST): DomainException {
    return new DomainException(ERROR_CODES.INVALID_MANAGER, message, status);
  }
}
