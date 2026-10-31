import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/pagination';

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// Offset pagination for ordinary lists. Feature DTOs extend it to add their own filters.
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: DEFAULT_PAGE, minimum: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = DEFAULT_PAGE;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @IsOptional()
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ description: 'Field to sort by; allowed values depend on the endpoint' })
  @IsString()
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @IsIn(SORT_ORDERS)
  @IsOptional()
  sortOrder: SortOrder = 'desc';
}
