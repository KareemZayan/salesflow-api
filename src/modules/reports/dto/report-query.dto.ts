import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from '../../../common/validators/is-date-only.validator';
import { REPORT_INTERVALS, ReportInterval } from '../reports.constants';

export class ReportRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    description:
      'First day counted (inclusive), written YYYY-MM-DD and read as UTC. Default: 30 days before `to`.',
  })
  @IsDateOnly()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-02-01',
    description:
      'Day the window ends (EXCLUSIVE), written YYYY-MM-DD and read as UTC. Default: tomorrow, so ' +
      'today is included. The window may be at most 366 days.',
  })
  @IsDateOnly()
  @IsOptional()
  to?: string;
}

export class RevenueByPeriodQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    enum: REPORT_INTERVALS,
    default: 'day',
    description:
      'Bucket size, calendar-aligned in UTC (weeks start on Monday). At most 31 days, 53 weeks or ' +
      '12 months per report.',
  })
  @IsIn(REPORT_INTERVALS)
  @IsOptional()
  interval?: ReportInterval;
}

export class PipelineSummaryQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Default: the default pipeline.' })
  @IsUUID()
  @IsOptional()
  pipelineId?: string;
}
