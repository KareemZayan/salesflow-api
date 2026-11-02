import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { OwnedListQueryDto } from '../../../common/dto/owned-list-query.dto';
import { DealStatus } from '../../../generated/prisma/client';
import { DEAL_SORT_FIELDS } from '../deals.constants';

// Every filter only narrows the list: it is ANDed with the caller's visibility.
export class ListDealsQueryDto extends OwnedListQueryDto {
  @ApiPropertyOptional({ enum: DEAL_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  stageId?: string;

  @ApiPropertyOptional({ enum: DealStatus })
  @IsEnum(DealStatus)
  @IsOptional()
  status?: DealStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  contactId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  companyId?: string;
}
