import { Controller, Get } from '@nestjs/common';
import { Permissions } from '../../src/common/decorators/permissions.decorator';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../src/common/interfaces/authenticated-user.interface';

// Test-only routes that put the global guards under real HTTP, before any feature module uses
// @Roles / @Permissions. Registered by createTestApp, never by AppModule.
@Controller('__probe')
export class ProbeController {
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
}
