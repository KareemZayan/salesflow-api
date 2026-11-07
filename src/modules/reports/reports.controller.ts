import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import {
  PipelineSummaryQueryDto,
  ReportRangeQueryDto,
  RevenueByPeriodQueryDto,
} from './dto/report-query.dto';
import {
  LeadConversionResponseDto,
  LeadsBySourceResponseDto,
  OverdueTasksResponseDto,
  PipelineSummaryResponseDto,
  RevenueByOwnerResponseDto,
  RevenueByPeriodResponseDto,
  WinRateResponseDto,
} from './dto/report-response.dto';
import { ReportsService } from './reports.service';

const VISIBILITY =
  'Counts only records the caller may see: admins the whole organization, managers their own and ' +
  'their direct reports, as everywhere else. ';
const WINDOW =
  'The window is [from, to) in UTC days; `to` is exclusive. Results may be up to 5 minutes old ' +
  '(`generatedAt` is when they were computed). ';
const INVALID_RANGE = 'VALIDATION_FAILED, or INVALID_REPORT_RANGE (empty, over 366 days)';
const FORBIDDEN = 'FORBIDDEN (missing reports:read)';

// HTTP only: parse, delegate, return. Everything is a read, so there is no write permission.
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
@Permissions('reports:read')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('pipeline-summary')
  @ApiOperation({
    summary: 'Deals per stage of a pipeline',
    description:
      VISIBILITY +
      'Every stage of the pipeline is listed in board order, empty ones too; the Won and Lost ' +
      'stages hold the closed deals. Amounts are grouped by currency and never converted. ' +
      'Defaults to the default pipeline. Results may be up to 5 minutes old.',
  })
  @ApiOkResponse({ type: PipelineSummaryResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiNotFoundResponse({
    description: 'RESOURCE_NOT_FOUND (unknown pipeline or another organization)',
  })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  pipelineSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: PipelineSummaryQueryDto,
  ): Promise<PipelineSummaryResponseDto> {
    return this.reports.pipelineSummary(actor, query);
  }

  @Get('win-rate')
  @ApiOperation({
    summary: 'Won versus lost deals',
    description:
      VISIBILITY +
      WINDOW +
      'Deals are counted by the instant they were closed. `winRate` = won / (won + lost) as a ' +
      'fraction, or null when nothing was closed.',
  })
  @ApiOkResponse({ type: WinRateResponseDto })
  @ApiBadRequestResponse({ description: INVALID_RANGE })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  winRate(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ReportRangeQueryDto,
  ): Promise<WinRateResponseDto> {
    return this.reports.winRate(actor, query);
  }

  @Get('revenue/by-period')
  @ApiOperation({
    summary: 'Revenue per day, week or month',
    description:
      VISIBILITY +
      WINDOW +
      'Revenue = WON deals by the instant they were closed. Buckets are calendar-aligned in UTC ' +
      '(weeks start on Monday); the first and last bucket are clamped to the window, so they may ' +
      'be partial. Every bucket lists every currency seen in the window (0.00 where none), and ' +
      'currencies are never added together. At most 31 days, 53 weeks or 12 months.',
  })
  @ApiOkResponse({ type: RevenueByPeriodResponseDto })
  @ApiBadRequestResponse({ description: INVALID_RANGE })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  revenueByPeriod(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: RevenueByPeriodQueryDto,
  ): Promise<RevenueByPeriodResponseDto> {
    return this.reports.revenueByPeriod(actor, query);
  }

  @Get('revenue/by-owner')
  @ApiOperation({
    summary: 'Revenue per deal owner',
    description:
      VISIBILITY + WINDOW + 'Revenue = WON deals by the instant they were closed, per currency.',
  })
  @ApiOkResponse({ type: RevenueByOwnerResponseDto })
  @ApiBadRequestResponse({ description: INVALID_RANGE })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  revenueByOwner(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ReportRangeQueryDto,
  ): Promise<RevenueByOwnerResponseDto> {
    return this.reports.revenueByOwner(actor, query);
  }

  @Get('lead-conversion')
  @ApiOperation({
    summary: 'Lead conversion rate',
    description:
      VISIBILITY +
      WINDOW +
      'A cohort: the leads CREATED in the window and, of those, the ones that are CONVERTED now, ' +
      'so the rate is always between 0 and 1 (null when no lead was created).',
  })
  @ApiOkResponse({ type: LeadConversionResponseDto })
  @ApiBadRequestResponse({ description: INVALID_RANGE })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  leadConversion(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ReportRangeQueryDto,
  ): Promise<LeadConversionResponseDto> {
    return this.reports.leadConversion(actor, query);
  }

  @Get('leads-by-source')
  @ApiOperation({
    summary: 'Leads per source',
    description:
      VISIBILITY + WINDOW + 'The same cohort as the conversion rate: leads created in the window.',
  })
  @ApiOkResponse({ type: LeadsBySourceResponseDto })
  @ApiBadRequestResponse({ description: INVALID_RANGE })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  leadsBySource(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ReportRangeQueryDto,
  ): Promise<LeadsBySourceResponseDto> {
    return this.reports.leadsBySource(actor, query);
  }

  @Get('overdue-tasks')
  @ApiOperation({
    summary: 'Overdue tasks per assignee and priority',
    description:
      'Visibility follows the ASSIGNEE: admins see the whole organization, managers their own and ' +
      'their team. Overdue is the same rule as `GET /tasks?overdue=true` (open, due before now). ' +
      'Results may be up to 60 seconds old. List the tasks themselves with ' +
      '`GET /tasks?overdue=true&assigneeId=...`.',
  })
  @ApiOkResponse({ type: OverdueTasksResponseDto })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  overdueTasks(@CurrentUser() actor: AuthenticatedUser): Promise<OverdueTasksResponseDto> {
    return this.reports.overdueTasks(actor);
  }
}
