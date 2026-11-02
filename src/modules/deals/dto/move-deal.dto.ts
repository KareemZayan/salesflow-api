import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { trimString } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { LOST_REASON_MAX_LENGTH } from '../deals.constants';

export class MoveDealDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Any stage of the deal pipeline. A Won stage wins the deal, a Lost stage loses it, an open ' +
      'stage keeps it open (and REOPENS a closed deal).',
  })
  @IsUUID()
  stageId!: string;

  @ApiPropertyOptional({
    maxLength: LOST_REASON_MAX_LENGTH,
    description: 'Required when the target is the Lost stage, rejected otherwise.',
  })
  @OptionalButNotNull()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LOST_REASON_MAX_LENGTH)
  lostReason?: string;
}
