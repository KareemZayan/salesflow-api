import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/pagination';

// Cursor pagination for large append-heavy tables (activities, audit logs): stable under inserts
// and constant-cost per page, unlike OFFSET.
export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page `meta.nextCursor`' })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @IsOptional()
  limit: number = DEFAULT_PAGE_SIZE;
}
