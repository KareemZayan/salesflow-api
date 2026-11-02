import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { trimString } from './create-role.dto';

export class UpdateRoleDto {
  @ApiPropertyOptional({ maxLength: ROLE_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROLE_NAME_MAX_LENGTH)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ maxLength: ROLE_DESCRIPTION_MAX_LENGTH })
  @IsString()
  @MaxLength(ROLE_DESCRIPTION_MAX_LENGTH)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the whole permission set of the role',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_PERMISSION_KEYS)
  @IsString({ each: true })
  @MaxLength(PERMISSION_KEY_MAX_LENGTH, { each: true })
  @IsOptional()
  permissionKeys?: string[];
}
