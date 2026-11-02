import { ApiProperty } from '@nestjs/swagger';

export class CompanyResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Acme Ltd' }) name!: string;
  @ApiProperty({ example: 'acme.com', nullable: true, type: String }) domain!: string | null;
  @ApiProperty({ example: 'Software', nullable: true, type: String }) industry!: string | null;
  @ApiProperty({ example: '+20 100 123 4567', nullable: true, type: String })
  phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
