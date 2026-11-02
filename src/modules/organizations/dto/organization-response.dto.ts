import { ApiProperty } from '@nestjs/swagger';

export class OrganizationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Acme Corp' }) name!: string;
  @ApiProperty({ example: 'acme', description: 'Immutable identifier' }) slug!: string;
  @ApiProperty({ example: 'USD', description: 'ISO 4217 default currency for new deals' })
  defaultCurrency!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
