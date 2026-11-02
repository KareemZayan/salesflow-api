import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '../../common/decorators/api-paginated-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { CreateRoleDto } from './dto/create-role.dto';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Permissions('roles:read')
  @ApiOperation({ summary: 'List the roles of your organization with their permissions' })
  @ApiPaginatedResponse(RoleResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing roles:read)' })
  list(@Query() query: ListRolesQueryDto): Promise<PaginatedResponseDto<RoleResponseDto>> {
    return this.roles.list(query);
  }

  @Get(':id')
  @Permissions('roles:read')
  @ApiOperation({ summary: 'Get one role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also for another organization)' })
  get(@Param() { id }: IdParamDto): Promise<RoleResponseDto> {
    return this.roles.get(id);
  }

  @Post()
  @Permissions('roles:manage')
  @ApiOperation({
    summary: 'Create a role',
    description: 'You can only grant permissions you hold yourself (ADMIN can grant any).',
  })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, ROLE_NAME_RESERVED or INVALID_PERMISSION',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN or CANNOT_GRANT_PERMISSION' })
  @ApiConflictResponse({ description: 'ROLE_NAME_ALREADY_EXISTS (case-insensitive)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRoleDto,
  ): Promise<RoleResponseDto> {
    return this.roles.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('roles:manage')
  @ApiOperation({
    summary: 'Update a role',
    description:
      '`permissionKeys` replaces the whole set. System roles cannot be renamed and ADMIN cannot ' +
      'be changed at all. Changes apply to signed-in users on their next request.',
  })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, ROLE_NAME_RESERVED or INVALID_PERMISSION',
  })
  @ApiForbiddenResponse({
    description: 'FORBIDDEN, SYSTEM_ROLE_IMMUTABLE or CANNOT_GRANT_PERMISSION',
  })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'ROLE_NAME_ALREADY_EXISTS' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleResponseDto> {
    return this.roles.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('roles:manage')
  @ApiOperation({ summary: 'Delete a custom role nobody holds' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description: 'FORBIDDEN, SYSTEM_ROLE_IMMUTABLE or CANNOT_GRANT_PERMISSION',
  })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'ROLE_IN_USE (inactive users count too)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.roles.delete(actor, id);
  }
}
