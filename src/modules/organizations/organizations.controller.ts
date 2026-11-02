import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OrganizationResponseDto } from './dto/organization-response.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';

// There is no :id on purpose: the only organization a caller can reach is their own.
@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations/current')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: "The signed-in user's organization (any authenticated user)" })
  @ApiOkResponse({ type: OrganizationResponseDto })
  @ApiForbiddenResponse({
    description: 'PASSWORD_CHANGE_REQUIRED while the password change is pending',
  })
  getCurrent(@CurrentUser() actor: AuthenticatedUser): Promise<OrganizationResponseDto> {
    return this.organizations.getCurrent(actor);
  }

  @Patch()
  @Permissions('organizations:update')
  @ApiOperation({
    summary: 'Update the organization name or default currency',
    description: 'The slug and the active flag cannot be changed through the API.',
  })
  @ApiOkResponse({ type: OrganizationResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED (also for an empty body or unknown fields)',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing organizations:update)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return this.organizations.updateCurrent(actor, dto);
  }
}
