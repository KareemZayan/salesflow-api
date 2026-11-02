import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { SEARCH_QUERY_MAX_LENGTH } from '../constants/search';
import { trimToUndefined } from '../utils/string-transform.util';
import { PaginationQueryDto } from './pagination-query.dto';

// Base query for lists of owned records (companies, contacts, leads, deals...). `ownerId` only
// narrows the list: it is ANDed with the caller's visibility, so asking for someone else's records
// yields an empty page, never their data.
export class OwnedListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive "contains" search; blank is ignored. `%` and `_` are literal.',
    maxLength: SEARCH_QUERY_MAX_LENGTH,
  })
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only records owned by this user' })
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}
