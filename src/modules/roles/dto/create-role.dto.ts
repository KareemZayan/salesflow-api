import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  MAX_PERMISSION_KEYS,
  PERMISSION_KEY_MAX_LENGTH,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from '../roles.constants';

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  @ApiProperty({ example: 'Support', maxLength: ROLE_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROLE_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({ maxLength: ROLE_DESCRIPTION_MAX_LENGTH })
  @IsString()
  @MaxLength(ROLE_DESCRIPTION_MAX_LENGTH)
  @IsOptional()
  description?: string;

  @ApiProperty({
    type: [String],
    example: ['users:read', 'leads:read'],
    description: 'Keys from GET /permissions. Duplicates are rejected.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_PERMISSION_KEYS)
  @IsString({ each: true })
  @MaxLength(PERMISSION_KEY_MAX_LENGTH, { each: true })
  permissionKeys!: string[];
}
