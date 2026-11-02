import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { trimString } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import {
  MAX_PERMISSION_KEYS,
  PERMISSION_KEY_MAX_LENGTH,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from '../roles.constants';

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
  @OptionalButNotNull()
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
