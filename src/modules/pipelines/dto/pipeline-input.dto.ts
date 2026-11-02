import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_OPEN_STAGES,
  OPEN_STAGE_MAX_PROBABILITY,
  PIPELINE_NAME_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
} from '../../../common/policies/pipeline-policy';
import { trimString } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';

export class OpenStageInputDto {
  @ApiProperty({ example: 'Negotiation', maxLength: STAGE_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(STAGE_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    example: 60,
    minimum: 0,
    maximum: OPEN_STAGE_MAX_PROBABILITY,
    description: 'Win percentage. The Won and Lost stages are fixed by the server (100 and 0).',
  })
  @IsInt()
  @Min(0)
  @Max(OPEN_STAGE_MAX_PROBABILITY)
  probability!: number;
}

export class CreatePipelineDto {
  @ApiProperty({ example: 'Enterprise', maxLength: PIPELINE_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PIPELINE_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    type: [OpenStageInputDto],
    description:
      'Open stages in board order. The server appends Won and Lost. Omit it to copy the default ' +
      'template.',
  })
  @OptionalButNotNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OPEN_STAGES)
  @ValidateNested({ each: true })
  @Type(() => OpenStageInputDto)
  stages?: OpenStageInputDto[];
}

export class UpdatePipelineDto {
  @ApiPropertyOptional({ maxLength: PIPELINE_NAME_MAX_LENGTH })
  @OptionalButNotNull()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PIPELINE_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    enum: [true],
    description: 'Only `true` is accepted: it makes this pipeline the default.',
  })
  @OptionalButNotNull()
  @Equals(true, { message: 'isDefault can only be set to true' })
  isDefault?: true;
}

export class UpdateStageDto {
  @ApiPropertyOptional({ maxLength: STAGE_NAME_MAX_LENGTH })
  @OptionalButNotNull()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(STAGE_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: OPEN_STAGE_MAX_PROBABILITY,
    description: 'Open stages only; Won and Lost have a fixed probability.',
  })
  @OptionalButNotNull()
  @IsInt()
  @Min(0)
  @Max(OPEN_STAGE_MAX_PROBABILITY)
  probability?: number;
}

export class ReorderStagesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'EVERY open stage id, once, in the new order. Won and Lost stay last.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OPEN_STAGES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  stageIds!: string[];
}

export class StageParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stageId!: string;
}
