import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SEARCH_QUERY_MAX_LENGTH } from '../../../common/constants/search';
import { queryBoolean, trimToUndefined } from '../../../common/utils/string-transform.util';
import { IsInstant } from '../../../common/validators/is-instant.validator';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/client';
import { TASK_SORT_FIELDS } from '../tasks.constants';

// Every filter only narrows the list: it is ANDed with the caller's visibility. Tasks have no
// `ownerId`; the assignee plays that role, so `assigneeId` is the "owner" filter.
export class ListTasksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TASK_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive "contains" search on the title; blank is ignored.',
    maxLength: SEARCH_QUERY_MAX_LENGTH,
  })
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: TaskStatus })
  @IsEnum(TaskStatus)
  @IsOptional()
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only tasks assigned to this user' })
  @IsUUID()
  @IsOptional()
  assigneeId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  leadId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  dealId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  contactId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  companyId?: string;

  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59Z',
    description: 'Due at or before this instant (ISO 8601 with timezone)',
  })
  @IsInstant()
  @IsOptional()
  dueBefore?: string;

  @ApiPropertyOptional({
    example: '2026-12-01T00:00:00Z',
    description: 'Due at or after this instant (ISO 8601 with timezone)',
  })
  @IsInstant()
  @IsOptional()
  dueAfter?: string;

  @ApiPropertyOptional({
    description:
      '`true` = only overdue tasks (open and due before now); `false` = only those that are not. ' +
      'Same rule as the `isOverdue` field of the response.',
  })
  @Transform(queryBoolean)
  @IsBoolean()
  @IsOptional()
  overdue?: boolean;
}
