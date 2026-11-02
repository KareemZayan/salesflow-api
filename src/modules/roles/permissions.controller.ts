import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { PermissionResponseDto } from './dto/role-response.dto';
import { RolesService } from './roles.service';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Permissions('roles:read')
  @ApiOperation({
    summary: 'The permission catalogue',
    description:
      'A fixed, small, global list (defined by the application), so it is not paginated.',
  })
  @ApiOkResponse({ type: [PermissionResponseDto] })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing roles:read)' })
  list(): Promise<PermissionResponseDto[]> {
    return this.roles.listPermissions();
  }
}
