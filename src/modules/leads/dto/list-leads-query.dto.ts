import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { OwnedListQueryDto } from '../../../common/dto/owned-list-query.dto';
import { LeadSource, LeadStatus } from '../../../generated/prisma/client';
import { LEAD_SORT_FIELDS } from '../leads.constants';

export class ListLeadsQueryDto extends OwnedListQueryDto {
  @ApiPropertyOptional({ enum: LEAD_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({ enum: LeadStatus })
  @IsEnum(LeadStatus)
  @IsOptional()
  status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadSource })
  @IsEnum(LeadSource)
  @IsOptional()
  source?: LeadSource;
}
