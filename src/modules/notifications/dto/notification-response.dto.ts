import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '../../../generated/prisma/client';

export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: NotificationType }) type!: NotificationType;
  @ApiProperty({ example: 'A task was assigned to you' }) title!: string;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { taskId: '3f0c2f0e-6a52-4d5e-9d8c-6a1d2b0c4e11' },
    description: 'Ids of the records the notification is about, so a client can link to them.',
  })
  payload!: Record<string, string> | null;
  @ApiProperty({ nullable: true, type: Date }) readAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3 }) count!: number;
}

export class MarkAllReadResponseDto {
  @ApiProperty({ example: 3, description: 'How many notifications were unread and are now read' })
  updated!: number;
}
