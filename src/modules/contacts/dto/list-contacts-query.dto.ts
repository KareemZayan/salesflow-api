import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { OwnedListQueryDto } from '../../../common/dto/owned-list-query.dto';
import { CONTACT_SORT_FIELDS } from '../contacts.constants';

export class ListContactsQueryDto extends OwnedListQueryDto {
  @ApiPropertyOptional({ enum: CONTACT_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only contacts of this company. Narrows the list; it never widens it.',
  })
  @IsUUID()
  @IsOptional()
  companyId?: string;
}
