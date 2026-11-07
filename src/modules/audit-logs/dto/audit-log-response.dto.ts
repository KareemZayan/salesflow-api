import { ApiProperty } from '@nestjs/swagger';
import { AuditAction, Prisma } from '../../../generated/prisma/client';

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'user.deactivated' }) event!: string;
  @ApiProperty({ enum: AuditAction }) action!: AuditAction;
  @ApiProperty({ example: 'User' }) entityType!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'The audited record. It may no longer exist: the log outlives it.',
  })
  entityId!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'null = the system' })
  actorId!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: { isActive: true },
    description: 'Changed fields only, allowlisted per entity. Never secrets or free text.',
  })
  before!: Prisma.JsonValue;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: { isActive: false },
  })
  after!: Prisma.JsonValue;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Personal data: exposed to administrators through this endpoint only',
  })
  ipAddress!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Personal data: exposed to administrators through this endpoint only',
  })
  userAgent!: string | null;
  @ApiProperty({ nullable: true, type: String }) requestId!: string | null;
  @ApiProperty() createdAt!: Date;
}
