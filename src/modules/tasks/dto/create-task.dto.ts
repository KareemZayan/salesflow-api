import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { trimString, trimToUndefined } from '../../../common/utils/string-transform.util';
import { IsInstant } from '../../../common/validators/is-instant.validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { TaskPriority } from '../../../generated/prisma/client';
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from '../tasks.constants';

export class CreateTaskDto {
  @ApiProperty({ example: 'Send the revised quote', maxLength: TASK_TITLE_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({ maxLength: TASK_DESCRIPTION_MAX_LENGTH })
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(TASK_DESCRIPTION_MAX_LENGTH)
  @OptionalButNotNull()
  description?: string;

  @ApiPropertyOptional({ enum: TaskPriority, default: TaskPriority.MEDIUM })
  @IsEnum(TaskPriority)
  @OptionalButNotNull()
  priority?: TaskPriority;

  @ApiPropertyOptional({
    example: '2026-12-01T09:00:00+02:00',
    description:
      'A full instant: ISO 8601 date-time WITH a timezone offset (`Z` or `+hh:mm`), stored in UTC. ' +
      'A date alone is rejected. A time in the past is allowed (backlog entries).',
  })
  @IsInstant()
  @OptionalButNotNull()
  dueDate?: string;

  @ApiPropertyOptional({
    example: '2026-12-01T08:00:00Z',
    description:
      'When to be reminded: ISO 8601 with timezone. Must be in the future and not after `dueDate`. ' +
      'Stored now; the reminder itself is sent by a job (Phase 12).',
  })
  @IsInstant()
  @OptionalButNotNull()
  reminderAt?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to you' })
  @IsUUID()
  @OptionalButNotNull()
  assigneeId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A lead you can see' })
  @IsUUID()
  @OptionalButNotNull()
  leadId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A deal you can see' })
  @IsUUID()
  @OptionalButNotNull()
  dealId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A contact you can see' })
  @IsUUID()
  @OptionalButNotNull()
  contactId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A company you can see' })
  @IsUUID()
  @OptionalButNotNull()
  companyId?: string;
}
