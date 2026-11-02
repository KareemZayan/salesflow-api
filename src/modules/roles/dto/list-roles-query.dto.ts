import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { ROLE_SORT_FIELDS } from '../roles.constants';

export class ListRolesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ROLE_SORT_FIELDS, default: 'name' })
  declare sortBy?: string;
}
