import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { queryBoolean } from '../../../common/utils/string-transform.util';
import { NOTIFICATION_SORT_FIELDS } from '../notifications.constants';

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: NOTIFICATION_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({ description: '`true` = only notifications you have not read yet.' })
  @Transform(queryBoolean)
  @IsBoolean()
  @IsOptional()
  unread?: boolean;
}
