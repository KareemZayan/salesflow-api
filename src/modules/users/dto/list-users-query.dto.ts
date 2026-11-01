import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SEARCH_MAX_LENGTH, USER_SORT_FIELDS } from '../users.constants';

export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: USER_SORT_FIELDS, default: 'createdAt' })
  declare sortBy?: string;

  @ApiPropertyOptional({ description: 'Matches first name, last name or email (contains)' })
  @IsString()
  @MaxLength(SEARCH_MAX_LENGTH)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Direct reports of this manager' })
  @IsUUID()
  @IsOptional()
  managerId?: string;

  @ApiPropertyOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
