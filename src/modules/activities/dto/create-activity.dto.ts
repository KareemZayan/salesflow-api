import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trimString, trimToUndefined } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import {
  ACTIVITY_BODY_MAX_LENGTH,
  ACTIVITY_SUBJECT_MAX_LENGTH,
  MANUAL_ACTIVITY_TYPES,
  ManualActivityType,
} from '../activities.constants';

export class CreateActivityDto {
  @ApiProperty({
    enum: MANUAL_ACTIVITY_TYPES,
    description: 'STAGE_CHANGE and SYSTEM are server-only',
  })
  @IsIn(MANUAL_ACTIVITY_TYPES)
  type!: ManualActivityType;

  @ApiProperty({ example: 'Intro call', maxLength: ACTIVITY_SUBJECT_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ACTIVITY_SUBJECT_MAX_LENGTH)
  subject!: string;

  @ApiPropertyOptional({
    maxLength: ACTIVITY_BODY_MAX_LENGTH,
    description:
      'Free text, visible to everyone who can see the record. Do not store secrets or sensitive ' +
      'personal data here. Blank = no body.',
  })
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(ACTIVITY_BODY_MAX_LENGTH)
  @OptionalButNotNull()
  body?: string;
}
