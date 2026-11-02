import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { DEAL_HISTORY_SORT_FIELDS } from '../deals.constants';

// Offset pagination: one deal has a handful of stage changes, and the list is not append-heavy
// across deals (it is always scoped to a single deal).
export class ListDealHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DEAL_HISTORY_SORT_FIELDS, default: 'changedAt' })
  declare sortBy?: string;
}
