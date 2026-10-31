import { ApiProperty } from '@nestjs/swagger';

export class MeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  organizationId!: string;

  @ApiProperty({ example: 'rep@example.com' })
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ example: 'SALES_REP' })
  role!: string;

  @ApiProperty({ type: [String], example: ['leads:read', 'leads:create'] })
  permissions!: string[];

  @ApiProperty()
  mustChangePassword!: boolean;
}
