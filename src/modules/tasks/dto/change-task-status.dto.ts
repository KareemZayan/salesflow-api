import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TaskStatus } from '../../../generated/prisma/client';

export class ChangeTaskStatusDto {
  @ApiProperty({
    enum: TaskStatus,
    description:
      'OPEN -> IN_PROGRESS | COMPLETED | CANCELLED; IN_PROGRESS -> OPEN | COMPLETED | CANCELLED; ' +
      'COMPLETED and CANCELLED -> OPEN (reopen).',
  })
  @IsEnum(TaskStatus)
  status!: TaskStatus;
}
