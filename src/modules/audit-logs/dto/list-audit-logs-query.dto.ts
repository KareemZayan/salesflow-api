import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { CursorQueryDto } from '../../../common/dto/cursor-query.dto';
import { IsInstant } from '../../../common/validators/is-instant.validator';
import { AuditAction } from '../../../generated/prisma/client';
import { AUDIT_ENTITY_TYPES, AUDIT_EVENTS } from '../audit-events';

export class ListAuditLogsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Who did it' })
  @IsUUID()
  @IsOptional()
  actorId?: string;

  @ApiPropertyOptional({ enum: AUDIT_ENTITY_TYPES })
  @IsIn(AUDIT_ENTITY_TYPES)
  @IsOptional()
  entityType?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The audited record (use with entityType)' })
  @IsUUID()
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsEnum(AuditAction)
  @IsOptional()
  action?: AuditAction;

  @ApiPropertyOptional({ enum: AUDIT_EVENTS })
  @IsIn(AUDIT_EVENTS)
  @IsOptional()
  event?: string;

  @ApiPropertyOptional({ description: 'From (inclusive), ISO 8601 with a timezone' })
  @IsInstant()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'To (inclusive), ISO 8601 with a timezone' })
  @IsInstant()
  @IsOptional()
  to?: string;
}
