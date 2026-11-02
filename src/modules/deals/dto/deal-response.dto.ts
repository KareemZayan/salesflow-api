import { ApiProperty } from '@nestjs/swagger';
import { DealStatus } from '../../../generated/prisma/client';

// Ids only for the linked records: a contact or company may be deleted later, and reading the deal
// must never depend on them still existing.
export class DealResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Globex annual licence' }) title!: string;
  @ApiProperty({ example: '12500.00', description: 'Decimal string, always 2 decimals' })
  amount!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ example: '2026-12-31', nullable: true, type: String })
  expectedCloseDate!: string | null;
  @ApiProperty({ enum: DealStatus, description: 'Follows the stage: Won = WON, Lost = LOST' })
  status!: DealStatus;
  @ApiProperty({ nullable: true, type: String }) lostReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) closedAt!: Date | null;
  @ApiProperty({ format: 'uuid' }) pipelineId!: string;
  @ApiProperty({ format: 'uuid' }) stageId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) contactId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) companyId!: string | null;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
