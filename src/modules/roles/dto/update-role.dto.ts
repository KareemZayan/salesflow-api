import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import {
  MAX_PERMISSION_KEYS,
  PERMISSION_KEY_MAX_LENGTH,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from '../roles.constants';
import { trimString } from '../../../common/utils/string-transform.util';

export class UpdateRoleDto {
  @ApiPropertyOptional({ maxLength: ROLE_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROLE_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  name?: string;

  @ApiPropertyOptional({ maxLength: ROLE_DESCRIPTION_MAX_LENGTH })
  @IsString()
  @MaxLength(ROLE_DESCRIPTION_MAX_LENGTH)
  @OptionalButNotNull()
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
  @OptionalButNotNull()
  permissionKeys?: string[];
}
