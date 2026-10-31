import { ApiProperty } from '@nestjs/swagger';

export class PageMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 135 }) total!: number;
  @ApiProperty({ example: 7 }) totalPages!: number;
}

export class CursorMetaDto {
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ nullable: true, type: String, description: 'null on the last page' })
  nextCursor!: string | null;
}

// List endpoints return `{ data, meta }`; single resources return the DTO itself (ADR 0001).
export class PaginatedResponseDto<T> {
  data!: T[];
  meta!: PageMetaDto;
}

export class CursorPaginatedResponseDto<T> {
  data!: T[];
  meta!: CursorMetaDto;
}
