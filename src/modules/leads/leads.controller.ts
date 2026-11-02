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
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { ConvertLeadResponseDto } from './dto/convert-lead-response.dto';
import { ChangeLeadStatusDto } from './dto/change-lead-status.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadResponseDto } from './dto/lead-response.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadConversionService } from './lead-conversion.service';
import { LeadsService } from './leads.service';

@ApiTags('Leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly conversion: LeadConversionService,
  ) {}

  @Get()
  @Permissions('leads:read')
  @ApiOperation({
    summary: 'List the leads you may see',
    description:
      'Admins see the whole organization, managers their own and their team, everyone else only ' +
      'their own. `ownerId`, `status` and `source` narrow the list; they never widen it. Offset ' +
      'pagination: lead lists are small and not append-heavy.',
  })
  @ApiPaginatedResponse(LeadResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListLeadsQueryDto,
  ): Promise<PaginatedResponseDto<LeadResponseDto>> {
    return this.leads.list(actor, query);
  }

  @Get(':id')
  @Permissions('leads:read')
  @ApiOperation({ summary: 'Get one lead' })
  @ApiOkResponse({ type: LeadResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<LeadResponseDto> {
    return this.leads.get(actor, id);
  }

  @Post()
  @Permissions('leads:create')
  @ApiOperation({
    summary: 'Create a lead',
    description:
      'The owner defaults to you; every lead has an owner. The score is computed by the server ' +
      'from source, email, phone and company name. New leads start as NEW. `score`, `status` and ' +
      'the conversion fields cannot be sent.',
  })
  @ApiCreatedResponse({ type: LeadResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_OWNER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:create)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateLeadDto,
  ): Promise<LeadResponseDto> {
    return this.leads.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('leads:update')
  @ApiOperation({
    summary: 'Update a lead',
    description:
      'Send `null` (or a blank string) to clear email, phone, company name or notes. Changing ' +
      'source, email, phone or company name recomputes the score. An empty body is rejected. ' +
      'Changing `ownerId` transfers the lead: reps cannot, managers can within their team, ' +
      'admins anywhere.',
  })
  @ApiOkResponse({ type: LeadResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED, EMPTY_UPDATE or INVALID_OWNER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'LEAD_ALREADY_CONVERTED (a converted lead is read-only)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateLeadDto,
  ): Promise<LeadResponseDto> {
    return this.leads.update(actor, id, dto);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @Permissions('leads:update')
  @ApiOperation({
    summary: 'Change a lead status',
    description:
      'Allowed moves: NEW to CONTACTED or UNQUALIFIED; CONTACTED to QUALIFIED or UNQUALIFIED; ' +
      'QUALIFIED to UNQUALIFIED; UNQUALIFIED back to CONTACTED (reopen). CONVERTED is set only by ' +
      'lead conversion and cannot be requested. The move is computed from the status the server ' +
      'reads, so only the target is sent. The score does not depend on the status and is not ' +
      'changed. The change is not idempotent: asking for the status the lead already has, or ' +
      'retrying a change that was already applied, answers 409 INVALID_STATUS_TRANSITION. After a ' +
      '409, GET the lead to see its current status.',
  })
  @ApiOkResponse({ type: LeadResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED (unknown status, CONVERTED, or any field besides `status`)',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'INVALID_STATUS_TRANSITION (this move is not possible from the current status, or the ' +
      'status changed in the meantime) or LEAD_ALREADY_CONVERTED (the lead is final)',
  })
  changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ChangeLeadStatusDto,
  ): Promise<LeadResponseDto> {
    return this.leads.changeStatus(actor, id, dto);
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  @Permissions('leads:convert')
  @ApiOperation({
    summary: 'Convert a QUALIFIED lead into a contact (and optionally a company)',
    description:
      'One transaction: creates a contact from the lead (or links an existing one with ' +
      '`contactId`, which is never modified), optionally creates (`createCompany`) or links ' +
      '(`companyId`) a company for a NEW contact, and marks the lead CONVERTED. New records are ' +
      'owned by the lead owner. The score is unchanged. Conflicting options are rejected: ' +
      '`contactId` excludes the other two, and `companyId` excludes `createCompany`. Creating a ' +
      'contact also needs contacts:create and `createCompany` needs companies:create; linking an ' +
      'existing contact needs only leads:convert. A `lead.converted` event follows the commit. ' +
      'Deals are not part of conversion yet: a `deal` field is rejected.',
  })
  @ApiOkResponse({ type: ConvertLeadResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, INVALID_CONVERSION_OPTIONS, INVALID_CONTACT, INVALID_COMPANY or INVALID_OWNER',
  })
  @ApiForbiddenResponse({
    description:
      'FORBIDDEN (missing leads:convert, or contacts:create / companies:create for what would be created)',
  })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'LEAD_ALREADY_CONVERTED, or INVALID_STATUS_TRANSITION (the lead is not QUALIFIED, or its ' +
      'status changed in the meantime)',
  })
  convert(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ConvertLeadDto,
  ): Promise<ConvertLeadResponseDto> {
    return this.conversion.convert(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('leads:delete')
  @ApiOperation({ summary: 'Delete a lead (soft delete)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  @ApiConflictResponse({
    description: 'LEAD_ALREADY_CONVERTED (a converted lead cannot be deleted)',
  })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.leads.delete(actor, id);
  }
}
