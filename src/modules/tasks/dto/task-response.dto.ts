import { ApiProperty } from '@nestjs/swagger';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/client';

// Ids only for the linked records: a lead, deal, contact or company may be deleted later, and
// reading the task must never depend on them still existing.
export class TaskResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Send the revised quote' }) title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: TaskStatus }) status!: TaskStatus;
  @ApiProperty({ enum: TaskPriority }) priority!: TaskPriority;
  @ApiProperty({ nullable: true, type: Date, description: 'UTC instant' }) dueDate!: Date | null;
  @ApiProperty({
    description:
      'Computed at request time: still open and due before now. Never stored; the `overdue` list ' +
      'filter uses the same rule.',
  })
  isOverdue!: boolean;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'UTC instant' }) reminderAt!: Date | null;
  @ApiProperty({ format: 'uuid' }) assigneeId!: string;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) leadId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) dealId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) contactId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) companyId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
