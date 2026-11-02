import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { Permissions } from '../../src/common/decorators/permissions.decorator';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../src/common/interfaces/authenticated-user.interface';
import { applyVisibility, assertVisible } from '../../src/common/visibility/ownership-filter';
import { OwnershipScopeService } from '../../src/common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../src/common/visibility/visibility.types';

// Test-only routes that put the global guards under real HTTP, before any feature module uses
// @Roles / @Permissions. Registered by createTestApp, never by AppModule.
@Controller('__probe')
export class ProbeController {
  constructor(private readonly ownership: OwnershipScopeService) {}

  @Get('open')
  open(@CurrentUser() user: AuthenticatedUser): { organizationId: string } {
    return { organizationId: user.organizationId };
  }

  @Roles('ADMIN')
  @Get('admin-only')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  @Permissions('leads:read')
  @Get('leads-read')
  leadsRead(): { ok: true } {
    return { ok: true };
  }

  // Phase 7+ repositories will do exactly this: resolve once, then AND the scope into their query.
  @Get('visibility')
  async visibility(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ scope: VisibilityScope; where: unknown }> {
    const scope = await this.ownership.resolve(user);
    return { scope, where: applyVisibility({ status: 'NEW' }, scope) };
  }

  @Get('visible/:ownerId')
  async visible(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId') ownerId: string,
  ): Promise<{ ok: true }> {
    assertVisible(await this.ownership.resolve(user), ownerId === 'none' ? null : ownerId);
    return { ok: true };
  }
}
