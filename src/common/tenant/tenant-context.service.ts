import { Injectable } from '@nestjs/common';
import { ClsService, ClsStore } from 'nestjs-cls';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

interface TenantStore extends ClsStore {
  organizationId?: string;
  userId?: string;
  includeDeleted?: boolean;
}

// Request-scoped tenant identity (nestjs-cls). The organization comes from the JWT via
// `setUser`, or from the job payload via `run`; it is never read from request input.
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService<TenantStore>) {}

  get organizationId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('organizationId') : undefined;
  }

  get userId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('userId') : undefined;
  }

  get includeDeleted(): boolean {
    return this.cls.isActive() && this.cls.get('includeDeleted') === true;
  }

  // Called by the auth guard/strategy once the JWT is verified (Phase 6).
  setUser({ userId, organizationId }: Pick<AuthenticatedUser, 'userId' | 'organizationId'>): void {
    this.cls.set('userId', userId);
    this.cls.set('organizationId', organizationId);
  }

  // Background jobs and scripts: run `fn` inside the tenant named in the job payload. `await fn()`
  // happens inside the context on purpose: a Prisma query is lazy and would otherwise execute
  // after the context has ended, i.e. without a tenant.
  run<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return this.cls.runWith({ organizationId }, async () => await fn());
  }

  // Explicit opt-out of the `deletedAt: null` filter (restore, trash views). Scoped to `fn`.
  withDeleted<T>(fn: () => Promise<T>): Promise<T> {
    return this.cls.runWith({ ...this.cls.get(), includeDeleted: true }, async () => await fn());
  }
}
