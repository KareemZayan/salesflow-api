import { ApiProperty } from '@nestjs/swagger';

export class UserRoleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SALES_REP' }) name!: string;
}

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'jane.doe@acme.com' }) email!: string;
  @ApiProperty({ example: 'Jane' }) firstName!: string;
  @ApiProperty({ example: 'Doe' }) lastName!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ description: 'The user must change the password before using the API' })
  mustChangePassword!: boolean;
  @ApiProperty({ type: UserRoleDto }) role!: UserRoleDto;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) managerId!: string | null;
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
