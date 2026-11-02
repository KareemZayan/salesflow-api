import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '../constants/error-codes';
import { ADMIN_ROLE_NAME, SALES_MANAGER_ROLE_NAME } from '../constants/roles';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { VisibilityRepository } from './visibility.repository';
import { VisibilityScope } from './visibility.types';

// Resolves "whose records may this caller see" (own / team / all) once per request. Feature
// repositories combine the result with their own filters through applyVisibility().
//
//   ADMIN          -> everything in the organization
//   SALES_MANAGER  -> own + direct reports
//   anything else  -> own only (custom roles fail closed)
@Injectable()
export class OwnershipScopeService {
  constructor(
    private readonly repository: VisibilityRepository,
    private readonly cls: ClsService,
  ) {}

  async resolve(actor: AuthenticatedUser | undefined): Promise<VisibilityScope> {
    // Without an identity there is no safe default: refuse instead of guessing a scope.
    if (!actor) {
      throw new DomainException(
        ERROR_CODES.UNAUTHORIZED,
        'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (actor.role === ADMIN_ROLE_NAME) return { kind: 'all' };
    if (actor.role !== SALES_MANAGER_ROLE_NAME) return { kind: 'owners', ownerIds: [actor.userId] };
    return this.cachedForRequest(actor.userId, async () => ({
      kind: 'owners',
      ownerIds: [actor.userId, ...(await this.repository.findDirectReportIds(actor.userId))],
    }));
  }

  // The CLS store lives for one request, so the team is never reused across requests (a changed
  // team applies on the next call). The promise is cached, so parallel calls share one query.
  // Outside a request (no CLS context) nothing is cached.
  private cachedForRequest(
    userId: string,
    load: () => Promise<VisibilityScope>,
  ): Promise<VisibilityScope> {
    if (!this.cls.isActive()) return load();
    const key = `visibility:${userId}`;
    const hit = this.cls.get<Promise<VisibilityScope> | undefined>(key);
    if (hit) return hit;
    const pending = load().catch((error: unknown) => {
      this.cls.set(key, undefined);
      throw error;
    });
    this.cls.set(key, pending);
    return pending;
  }
}
