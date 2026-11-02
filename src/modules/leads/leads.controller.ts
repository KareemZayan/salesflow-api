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
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadResponseDto } from './dto/lead-response.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadsService } from './leads.service';

@ApiTags('Leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

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
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateLeadDto,
  ): Promise<LeadResponseDto> {
    return this.leads.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('leads:delete')
  @ApiOperation({ summary: 'Delete a lead (soft delete)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing leads:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.leads.delete(actor, id);
  }
}
