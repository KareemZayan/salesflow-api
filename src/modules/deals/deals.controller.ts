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
import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { DealHistoryResponseDto } from './dto/deal-history-response.dto';
import { DealResponseDto } from './dto/deal-response.dto';
import { ListDealHistoryQueryDto } from './dto/list-deal-history-query.dto';
import { MoveDealDto } from './dto/move-deal.dto';
import { ListDealsQueryDto } from './dto/list-deals-query.dto';
import { UpdateDealDto } from './dto/update-deal.dto';

@ApiTags('Deals')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @Permissions('deals:read')
  @ApiOperation({
    summary: 'List the deals you may see',
    description:
      'Admins see the whole organization, managers their own and their team, everyone else only ' +
      'their own. Every filter narrows the list; none widens it. Offset pagination.',
  })
  @ApiPaginatedResponse(DealResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:read)' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListDealsQueryDto,
  ): Promise<PaginatedResponseDto<DealResponseDto>> {
    return this.deals.list(actor, query);
  }

  @Get(':id')
  @Permissions('deals:read')
  @ApiOperation({ summary: 'Get one deal' })
  @ApiOkResponse({ type: DealResponseDto })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
  ): Promise<DealResponseDto> {
    return this.deals.get(actor, id);
  }

  @Post()
  @Permissions('deals:create')
  @ApiOperation({
    summary: 'Create a deal',
    description:
      'The deal is placed in the first open stage of the default pipeline unless `pipelineId` ' +
      'and/or `stageId` say otherwise (the stage must be an OPEN stage of that pipeline). ' +
      '`amount` is a decimal string and optional ("0.00" when omitted; never null). `currency` ' +
      'defaults to the organization currency. The owner defaults to you. The first stage-history ' +
      'row is written with the deal.',
  })
  @ApiCreatedResponse({ type: DealResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, INVALID_PIPELINE, INVALID_STAGE, INVALID_CONTACT, INVALID_COMPANY or INVALID_OWNER',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:create)' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateDealDto,
  ): Promise<DealResponseDto> {
    return this.deals.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('deals:update')
  @ApiOperation({
    summary: 'Update a deal',
    description:
      'Send `null` to clear contactId, companyId or expectedCloseDate. Stage and status change ' +
      'only through the move endpoint (sending them is a 400). A closed (WON / LOST) deal is ' +
      'read-only. Changing `ownerId` transfers the deal: reps cannot, managers can within their ' +
      'team, admins anywhere. Changes to amount and currency are logged (audit log: Phase 13).',
  })
  @ApiOkResponse({ type: DealResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, EMPTY_UPDATE, INVALID_CONTACT, INVALID_COMPANY or INVALID_OWNER',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'DEAL_CLOSED (a closed deal is read-only)' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateDealDto,
  ): Promise<DealResponseDto> {
    return this.deals.update(actor, id, dto);
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @Permissions('deals:update')
  @ApiOperation({
    summary: 'Move a deal to another stage of its pipeline',
    description:
      'Any stage of the deal pipeline, backwards included. The status follows the stage: a Won ' +
      'stage wins the deal, a Lost stage loses it (`lostReason` is then required, and rejected ' +
      'otherwise), an open stage keeps it OPEN. Moving a WON or LOST deal to an open stage ' +
      'REOPENS it (closedAt and lostReason are cleared). Every move writes a stage-history row ' +
      'in the same transaction. The move is computed from the stage the server reads, so two ' +
      'racing moves cannot both win; it is not idempotent (asking for the current stage is a ' +
      '409). A deal.stage_changed event follows the commit.',
  })
  @ApiOkResponse({ type: DealResponseDto })
  @ApiBadRequestResponse({
    description:
      'VALIDATION_FAILED, INVALID_STAGE, LOST_REASON_REQUIRED or LOST_REASON_NOT_ALLOWED',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({
    description:
      'INVALID_STAGE_MOVE (already in that stage) or DEAL_STAGE_CHANGED (moved in the meantime: ' +
      'GET the deal and decide)',
  })
  move(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: MoveDealDto,
  ): Promise<DealResponseDto> {
    return this.deals.move(actor, id, dto);
  }

  @Get(':id/history')
  @Permissions('deals:read')
  @ApiOperation({
    summary: 'Stage history of a deal, newest first',
    description:
      'Follows the deal visibility. The first row (fromStage null) is the placement at ' +
      'creation. Stage names come with the page, not per row. Offset pagination: a deal has a ' +
      'handful of changes.',
  })
  @ApiPaginatedResponse(DealHistoryResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:read)' })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (also when it is another organization or not yours to see)',
  })
  history(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Query() query: ListDealHistoryQueryDto,
  ): Promise<PaginatedResponseDto<DealHistoryResponseDto>> {
    return this.deals.history(actor, id, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('deals:delete')
  @ApiOperation({ summary: 'Delete a deal (soft delete)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing deals:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also when already deleted)' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.deals.delete(actor, id);
  }
}
