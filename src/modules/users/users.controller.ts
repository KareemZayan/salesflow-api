import {
  Body,
  Controller,
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
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Permissions('users:read')
  @ApiOperation({
    summary: 'List the users of your organization',
    description: 'Offset pagination: the list is small and bounded by the organization size.',
  })
  @ApiPaginatedResponse(UserResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing users:read)' })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedResponseDto<UserResponseDto>> {
    return this.users.list(query);
  }

  @Get(':id')
  @Permissions('users:read')
  @ApiOperation({ summary: 'Get one user' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also for another organization)' })
  get(@Param() { id }: IdParamDto): Promise<UserResponseDto> {
    return this.users.get(id);
  }

  @Post()
  @Permissions('users:create')
  @ApiOperation({
    summary: 'Create a user with a temporary password',
    description:
      'The user must change the password at first sign-in. Only an ADMIN can create an ADMIN.',
  })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, WEAK_PASSWORD, INVALID_ROLE, INVALID_MANAGER',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN or ADMIN_REQUIRED' })
  @ApiConflictResponse({ description: 'EMAIL_ALREADY_EXISTS' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateUserDto,
  ): Promise<UserResponseDto> {
    return this.users.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('users:update')
  @ApiOperation({
    summary: 'Update profile, role or manager',
    description: 'Send `managerId: null` to remove the manager. You cannot change your own role.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED, INVALID_ROLE, INVALID_MANAGER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN, ADMIN_REQUIRED or CANNOT_CHANGE_OWN_ROLE' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'EMAIL_ALREADY_EXISTS or LAST_ADMIN_REQUIRED' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.users.update(actor, id, dto);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Permissions('users:update')
  @ApiOperation({
    summary: 'Deactivate a user and revoke every session',
    description: 'Idempotent. Users are never deleted.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({ description: 'FORBIDDEN, ADMIN_REQUIRED or CANNOT_DEACTIVATE_SELF' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'LAST_ADMIN_REQUIRED or USER_HAS_ACTIVE_REPORTS' })
  deactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<UserResponseDto> {
    return this.users.deactivate(actor, id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Permissions('users:update')
  @ApiOperation({ summary: 'Reactivate a user', description: 'Idempotent.' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({ description: 'FORBIDDEN or ADMIN_REQUIRED' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'INVALID_MANAGER (the manager is inactive)' })
  reactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<UserResponseDto> {
    return this.users.reactivate(actor, id);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('users:update')
  @ApiOperation({
    summary: 'Set a temporary password for a user',
    description:
      'Revokes every session of the user and forces a password change at next sign-in. ' +
      'The password is never returned or logged.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or WEAK_PASSWORD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN, ADMIN_REQUIRED or CANNOT_RESET_OWN_PASSWORD' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ResetPasswordDto,
  ): Promise<void> {
    return this.users.resetPassword(actor, id, dto);
  }
}
