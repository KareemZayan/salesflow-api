import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { trimString, trimToNull } from '../../../common/utils/string-transform.util';
import { IsInstant } from '../../../common/validators/is-instant.validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { TaskPriority } from '../../../generated/prisma/client';
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from '../tasks.constants';

// `status` is NOT here: it changes only through POST /tasks/:id/status (sending it is a 400).
// `title`, `priority` and `assigneeId` are NOT NULL columns; the rest may be cleared with `null`.
export class UpdateTaskDto {
  @ApiPropertyOptional({ maxLength: TASK_TITLE_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  @OptionalButNotNull()
  title?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: '`null` or blank clears' })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(TASK_DESCRIPTION_MAX_LENGTH)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsEnum(TaskPriority)
  @OptionalButNotNull()
  priority?: TaskPriority;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '2026-12-01T09:00:00+02:00',
    description: 'ISO 8601 with timezone, stored in UTC; `null` clears. Resets a sent reminder.',
  })
  @IsInstant()
  @IsOptional()
  dueDate?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '2026-12-01T08:00:00Z',
    description:
      'ISO 8601 with timezone; must be in the future and not after the due date; `null` clears. ' +
      'Changing it re-arms the reminder.',
  })
  @IsInstant()
  @IsOptional()
  reminderAt?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Reassigns the task' })
  @IsUUID()
  @OptionalButNotNull()
  assigneeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: '`null` unlinks',
  })
  @IsUUID()
  @IsOptional()
  leadId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: '`null` unlinks',
  })
  @IsUUID()
  @IsOptional()
  dealId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: '`null` unlinks',
  })
  @IsUUID()
  @IsOptional()
  contactId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: '`null` unlinks',
  })
  @IsUUID()
  @IsOptional()
  companyId?: string | null;
}
