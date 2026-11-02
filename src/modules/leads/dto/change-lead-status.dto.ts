import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { LeadStatus } from '../../../generated/prisma/client';
import { SETTABLE_LEAD_STATUSES } from '../lead-status-transitions';

// Only the target. The "from" is always the status the server reads, never a client value.
export class ChangeLeadStatusDto {
  @ApiProperty({
    enum: SETTABLE_LEAD_STATUSES,
    example: LeadStatus.CONTACTED,
    description: 'CONVERTED cannot be requested: it is set only by lead conversion.',
  })
  @IsIn(SETTABLE_LEAD_STATUSES)
  status!: LeadStatus;
}
