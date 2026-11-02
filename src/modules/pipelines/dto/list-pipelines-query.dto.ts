import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PIPELINE_SORT_FIELDS } from '../pipelines.constants';

export class ListPipelinesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PIPELINE_SORT_FIELDS, default: 'name' })
  declare sortBy?: string;
}
