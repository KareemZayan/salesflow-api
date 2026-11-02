import { ApiProperty } from '@nestjs/swagger';

export class RoleResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SALES_REP' }) name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ description: 'Default roles cannot be renamed or deleted' }) isSystem!: boolean;
  @ApiProperty({ type: [String], example: ['leads:read'] }) permissionKeys!: string[];
  @ApiProperty({ description: 'Users holding the role, inactive ones included' })
  userCount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PermissionResponseDto {
  @ApiProperty({ example: 'leads:read' }) key!: string;
  @ApiProperty({ example: 'View leads' }) description!: string;
}
