import { ApiProperty } from '@nestjs/swagger';
import { LeadSource, TaskPriority } from '../../../generated/prisma/client';
import { REPORT_INTERVALS, ReportInterval } from '../reports.constants';

// Every report answers `generatedAt`: the instant it was COMPUTED. A cached answer keeps the value
// of the computation, so it tells the reader how old the numbers are. Dates are YYYY-MM-DD (UTC).

export class CurrencyTotalDto {
  @ApiProperty({ example: 'USD', description: 'ISO 4217. Currencies are never added together.' })
  currency!: string;
  @ApiProperty({ example: '12500.00', description: 'Decimal string, always 2 decimals' })
  amount!: string;
  @ApiProperty({ description: 'Deals behind this amount (0.00 deals are counted)' })
  dealCount!: number;
}

export class PipelineSummaryStageDto {
  @ApiProperty({ format: 'uuid' }) stageId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ description: '0-100' }) probability!: number;
  @ApiProperty() isWon!: boolean;
  @ApiProperty() isLost!: boolean;
  @ApiProperty({ description: 'Every deal in the stage, all currencies' }) dealCount!: number;
  @ApiProperty({ type: [CurrencyTotalDto] }) totals!: CurrencyTotalDto[];
}

export class PipelineSummaryPipelineDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class PipelineSummaryResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty({ type: PipelineSummaryPipelineDto }) pipeline!: PipelineSummaryPipelineDto;
  @ApiProperty() dealCount!: number;
  @ApiProperty({ type: [PipelineSummaryStageDto], description: 'In board order' })
  stages!: PipelineSummaryStageDto[];
}

export class WinRateResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty({ example: '2026-01-01' }) from!: string;
  @ApiProperty({ example: '2026-02-01', description: 'Exclusive' }) to!: string;
  @ApiProperty() wonCount!: number;
  @ApiProperty() lostCount!: number;
  @ApiProperty({ description: 'won + lost, closed inside the window' }) closedCount!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 0.6667,
    description: 'wonCount / closedCount, 4 decimals; null when nothing was closed',
  })
  winRate!: number | null;
  @ApiProperty({ type: [CurrencyTotalDto] }) won!: CurrencyTotalDto[];
  @ApiProperty({ type: [CurrencyTotalDto] }) lost!: CurrencyTotalDto[];
}

export class RevenueBucketDto {
  @ApiProperty({
    example: '2026-01-05',
    description: 'Inclusive; the first bucket may start later than its calendar period',
  })
  start!: string;
  @ApiProperty({ example: '2026-01-12', description: 'Exclusive; the last bucket may end earlier' })
  end!: string;
  @ApiProperty() dealCount!: number;
  @ApiProperty({
    type: [CurrencyTotalDto],
    description: 'One entry per currency seen in the window, 0.00 where the bucket had none',
  })
  totals!: CurrencyTotalDto[];
}

export class RevenueByPeriodResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty() from!: string;
  @ApiProperty({ description: 'Exclusive' }) to!: string;
  @ApiProperty({ enum: REPORT_INTERVALS }) interval!: ReportInterval;
  @ApiProperty({ type: [String], description: 'Currencies seen in the window, sorted' })
  currencies!: string[];
  @ApiProperty() dealCount!: number;
  @ApiProperty({ type: [RevenueBucketDto] }) buckets!: RevenueBucketDto[];
}

export class RevenueOwnerDto {
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ example: 'Dina Hassan' }) ownerName!: string;
  @ApiProperty() dealCount!: number;
  @ApiProperty({ type: [CurrencyTotalDto] }) totals!: CurrencyTotalDto[];
}

export class RevenueByOwnerResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty() from!: string;
  @ApiProperty({ description: 'Exclusive' }) to!: string;
  @ApiProperty() dealCount!: number;
  @ApiProperty({ type: [RevenueOwnerDto], description: 'Sorted by owner name' })
  owners!: RevenueOwnerDto[];
}

export class LeadConversionResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty() from!: string;
  @ApiProperty({ description: 'Exclusive' }) to!: string;
  @ApiProperty({ description: 'Leads created inside the window' }) totalLeads!: number;
  @ApiProperty({ description: 'Of those, the ones that are CONVERTED now' })
  convertedLeads!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 0.25,
    description: 'convertedLeads / totalLeads, 4 decimals; null when no lead was created',
  })
  conversionRate!: number | null;
}

export class LeadSourceCountDto {
  @ApiProperty({ enum: LeadSource }) source!: LeadSource;
  @ApiProperty() leadCount!: number;
  @ApiProperty() convertedCount!: number;
}

export class LeadsBySourceResponseDto {
  @ApiProperty() generatedAt!: string;
  @ApiProperty() from!: string;
  @ApiProperty({ description: 'Exclusive' }) to!: string;
  @ApiProperty({ description: 'Leads created inside the window' }) totalLeads!: number;
  @ApiProperty({ type: [LeadSourceCountDto], description: 'Every source, zeros included' })
  sources!: LeadSourceCountDto[];
}

export class OverdueAssigneeDto {
  @ApiProperty({ format: 'uuid' }) assigneeId!: string;
  @ApiProperty() assigneeName!: string;
  @ApiProperty() overdueCount!: number;
}

export class OverduePriorityDto {
  @ApiProperty({ enum: TaskPriority }) priority!: TaskPriority;
  @ApiProperty() overdueCount!: number;
}

export class OverdueTasksResponseDto {
  @ApiProperty({ description: 'The instant "overdue" was evaluated against' })
  generatedAt!: string;
  @ApiProperty() totalOverdue!: number;
  @ApiProperty({ type: [OverdueAssigneeDto], description: 'Most overdue first' })
  byAssignee!: OverdueAssigneeDto[];
  @ApiProperty({ type: [OverduePriorityDto], description: 'Every priority, zeros included' })
  byPriority!: OverduePriorityDto[];
}
