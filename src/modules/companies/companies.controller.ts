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
import { CompaniesService } from './companies.service';
import { CompanyResponseDto } from './dto/company-response.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @Permissions('companies:read')
  @ApiOperation({
    summary: 'List the companies you may see',
    description:
      'Admins see the whole organization, managers their own and their team, everyone else only ' +
      'their own. `ownerId` narrows the list; it never widens it. Offset pagination: company ' +
      'lists are small and not append-heavy.',
  })
  @ApiPaginatedResponse(CompanyResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing companies:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListCompaniesQueryDto,
  ): Promise<PaginatedResponseDto<CompanyResponseDto>> {
    return this.companies.list(actor, query);
  }

  @Get(':id')
  @Permissions('companies:read')
  @ApiOperation({ summary: 'Get one company' })
  @ApiOkResponse({ type: CompanyResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<CompanyResponseDto> {
    return this.companies.get(actor, id);
  }

  @Post()
  @Permissions('companies:create')
  @ApiOperation({
    summary: 'Create a company',
    description: 'The owner defaults to you. Names are not unique: duplicates are allowed.',
  })
  @ApiCreatedResponse({ type: CompanyResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_OWNER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing companies:create)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateCompanyDto,
  ): Promise<CompanyResponseDto> {
    return this.companies.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('companies:update')
  @ApiOperation({
    summary: 'Update a company',
    description:
      'Send `null` (or a blank string) to clear domain, industry, phone or address. An empty ' +
      'body is rejected. Changing `ownerId` transfers the company: reps cannot, managers can ' +
      'within their team, admins anywhere.',
  })
  @ApiOkResponse({ type: CompanyResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED, EMPTY_UPDATE or INVALID_OWNER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing companies:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateCompanyDto,
  ): Promise<CompanyResponseDto> {
    return this.companies.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('companies:delete')
  @ApiOperation({
    summary: 'Delete a company (soft delete)',
    description: 'Blocked while the company still has contacts, whoever owns them.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing companies:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  @ApiConflictResponse({ description: 'COMPANY_HAS_CONTACTS' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.companies.delete(actor, id);
  }
}
