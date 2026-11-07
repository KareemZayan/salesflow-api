import { ApiProperty } from '@nestjs/swagger';
import { ActivityType } from '../../../generated/prisma/client';

export class ActivityResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ActivityType }) type!: ActivityType;
  @ApiProperty({ example: 'Intro call' }) subject!: string;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: { kind: 'lead.status_changed', from: 'NEW', to: 'CONTACTED' },
    description:
      'Ids and enum values for system entries, null for manual ones. Deal details (under `deal`) ' +
      'appear on a lead, contact or company timeline only if you can see that deal.',
  })
  metadata!: Record<string, unknown> | null;
  @ApiProperty({ description: 'When it happened (the event time for system entries)' })
  occurredAt!: Date;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'null = the system' })
  actorId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) leadId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) dealId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) contactId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) companyId!: string | null;
  @ApiProperty({ description: 'Only manual entries (CALL, EMAIL, MEETING, NOTE) can be deleted' })
  isManual!: boolean;
  @ApiProperty() createdAt!: Date;
}
