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
import { ListPipelinesQueryDto } from './dto/list-pipelines-query.dto';
import {
  CreatePipelineDto,
  OpenStageInputDto,
  ReorderStagesDto,
  StageParamDto,
  UpdatePipelineDto,
  UpdateStageDto,
} from './dto/pipeline-input.dto';
import { PipelineResponseDto, StageResponseDto } from './dto/pipeline-response.dto';
import { PipelinesService } from './pipelines.service';

@ApiTags('Pipelines')
@ApiBearerAuth()
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @Get()
  @Permissions('pipelines:read')
  @ApiOperation({
    summary: 'List the pipelines of your organization with their stages',
    description:
      'Pipelines are shared by the whole organization (no owner). Offset pagination: there are ' +
      'few of them.',
  })
  @ApiPaginatedResponse(PipelineResponseDto)
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_SORT_FIELD' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:read)' })
  list(@Query() query: ListPipelinesQueryDto): Promise<PaginatedResponseDto<PipelineResponseDto>> {
    return this.pipelines.list(query);
  }

  @Get(':id')
  @Permissions('pipelines:read')
  @ApiOperation({ summary: 'Get one pipeline with its stages' })
  @ApiOkResponse({ type: PipelineResponseDto })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND (also for another organization)' })
  get(@Param() { id }: IdParamDto): Promise<PipelineResponseDto> {
    return this.pipelines.get(id);
  }

  @Post()
  @Permissions('pipelines:create')
  @ApiOperation({
    summary: 'Create a pipeline',
    description:
      'Send the open stages in board order; the server appends Won (100%) and Lost (0%). Omit ' +
      '`stages` to copy the default template. A new pipeline is not the default. Managers can ' +
      'create pipelines too: the effect is organization-wide (ADR 0009).',
  })
  @ApiCreatedResponse({ type: PipelineResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:create)' })
  @ApiConflictResponse({
    description: 'PIPELINE_NAME_ALREADY_EXISTS or STAGE_NAME_ALREADY_EXISTS (names are unique)',
  })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreatePipelineDto,
  ): Promise<PipelineResponseDto> {
    return this.pipelines.create(actor, dto);
  }

  @Patch(':id')
  @Permissions('pipelines:update')
  @ApiOperation({
    summary: 'Rename a pipeline or make it the default',
    description:
      '`isDefault: true` makes this pipeline the default and unsets the previous one atomically. ' +
      '`false` is rejected: pick another pipeline as the default instead.',
  })
  @ApiOkResponse({ type: PipelineResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or EMPTY_UPDATE' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'PIPELINE_NAME_ALREADY_EXISTS' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdatePipelineDto,
  ): Promise<PipelineResponseDto> {
    return this.pipelines.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('pipelines:delete')
  @ApiOperation({
    summary: 'Delete a pipeline (hard delete)',
    description:
      'Refused for the default pipeline and for any pipeline that has deals, soft-deleted deals ' +
      'included (the database keeps them linked to it).',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:delete)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'PIPELINE_IS_DEFAULT or PIPELINE_HAS_DEALS' })
  delete(@CurrentUser() actor: AuthenticatedUser, @Param() { id }: IdParamDto): Promise<void> {
    return this.pipelines.delete(actor, id);
  }

  @Post(':id/stages')
  @Permissions('pipelines:update')
  @ApiOperation({
    summary: 'Add an open stage',
    description:
      'The stage goes after the last open stage; Won and Lost move down by one. The probability ' +
      'is 0-99: only Won (100) and Lost (0) are fixed by the server.',
  })
  @ApiCreatedResponse({ type: StageResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or TOO_MANY_STAGES' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_NAME_ALREADY_EXISTS' })
  addStage(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IdParamDto,
    @Body() dto: OpenStageInputDto,
  ): Promise<StageResponseDto> {
    return this.pipelines.addStage(actor, id, dto);
  }

  @Patch(':id/stages/:stageId')
  @Permissions('pipelines:update')
  @ApiOperation({
    summary: 'Rename a stage or change its probability',
    description: 'Won and Lost can be renamed; their probability is fixed.',
  })
  @ApiOkResponse({ type: StageResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, EMPTY_UPDATE or TERMINAL_STAGE_PROBABILITY_FIXED',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_NAME_ALREADY_EXISTS' })
  updateStage(
    @Param() { id, stageId }: StageParamDto,
    @Body() dto: UpdateStageDto,
  ): Promise<StageResponseDto> {
    return this.pipelines.updateStage(id, stageId, dto);
  }

  @Delete(':id/stages/:stageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('pipelines:update')
  @ApiOperation({
    summary: 'Delete an open stage',
    description:
      'Refused for Won and Lost, for the last open stage, and for a stage with deals or stage ' +
      'history (soft-deleted deals included).',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'TERMINAL_STAGE_REQUIRED, PIPELINE_NEEDS_OPEN_STAGE or STAGE_IN_USE',
  })
  deleteStage(@Param() { id, stageId }: StageParamDto): Promise<void> {
    return this.pipelines.deleteStage(id, stageId);
  }

  @Post(':id/stages/reorder')
  @HttpCode(HttpStatus.OK)
  @Permissions('pipelines:update')
  @ApiOperation({
    summary: 'Reorder the open stages',
    description:
      'Send every open stage id once, in the new order. Won and Lost stay last. Positions are ' +
      'rewritten in one transaction.',
  })
  @ApiOkResponse({ type: PipelineResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED or INVALID_STAGE_ORDER' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN (missing pipelines:update)' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND' })
  reorderStages(
    @Param() { id }: IdParamDto,
    @Body() dto: ReorderStagesDto,
  ): Promise<PipelineResponseDto> {
    return this.pipelines.reorderStages(id, dto);
  }
}
