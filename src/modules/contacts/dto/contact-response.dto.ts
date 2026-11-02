import { ApiProperty } from '@nestjs/swagger';

export class ContactResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Sara' }) firstName!: string;
  @ApiProperty({ example: 'Hassan' }) lastName!: string;
  @ApiProperty({ example: 'sara@acme.com', nullable: true, type: String }) email!: string | null;
  @ApiProperty({ example: '+20 100 123 4567', nullable: true, type: String })
  phone!: string | null;
  @ApiProperty({ example: 'Head of Procurement', nullable: true, type: String })
  jobTitle!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) companyId!: string | null;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
