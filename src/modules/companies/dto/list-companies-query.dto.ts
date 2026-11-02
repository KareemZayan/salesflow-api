import { ApiPropertyOptional } from '@nestjs/swagger';
import { OwnedListQueryDto } from '../../../common/dto/owned-list-query.dto';
import { COMPANY_SORT_FIELDS } from '../companies.constants';

export class ListCompaniesQueryDto extends OwnedListQueryDto {
  @ApiPropertyOptional({ enum: COMPANY_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;
}
