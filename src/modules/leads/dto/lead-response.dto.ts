import { ApiProperty } from '@nestjs/swagger';
import { LeadSource, LeadStatus } from '../../../generated/prisma/client';

export class LeadResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Omar' }) firstName!: string;
  @ApiProperty({ example: 'Khaled' }) lastName!: string;
  @ApiProperty({ example: 'omar@globex.com', nullable: true, type: String }) email!: string | null;
  @ApiProperty({ example: '+20 100 123 4567', nullable: true, type: String })
  phone!: string | null;
  @ApiProperty({ example: 'Globex', nullable: true, type: String }) companyName!: string | null;
  @ApiProperty({ enum: LeadSource }) source!: LeadSource;
  @ApiProperty({ enum: LeadStatus }) status!: LeadStatus;
  @ApiProperty({ example: 65, minimum: 0, maximum: 100, description: 'Computed by the server' })
  score!: number;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ nullable: true, type: Date, description: 'Set by lead conversion only' })
  convertedAt!: Date | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) convertedContactId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) convertedDealId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
