import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { CursorPaginatedResponseDto, PaginatedResponseDto } from '../dto/paginated-response.dto';
import { DomainException } from '../exceptions/domain.exception';
import { PaginationQueryDto, SortOrder } from '../dto/pagination-query.dto';

export function toSkipTake({ page, limit }: Pick<PaginationQueryDto, 'page' | 'limit'>) {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildPaginated<T>(
  data: T[],
  total: number,
  { page, limit }: Pick<PaginationQueryDto, 'page' | 'limit'>,
): PaginatedResponseDto<T> {
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// One page of an offset-paginated list. The SAME `where` goes to the rows and to the count, so the
// total can never include rows the page query would hide. `id` is the tiebreaker that keeps pages
// stable when the sort column has duplicates. A plain function (no base class): the Prisma delegate
// differs per model, so the caller passes the two queries.
export async function queryPage<T, W, F extends string>(
  query: Pick<PaginationQueryDto, 'page' | 'limit' | 'sortBy' | 'sortOrder'>,
  options: {
    where: W;
    sortFields: readonly F[];
    fallbackSort: F;
    find: (args: {
      where: W;
      orderBy: [Record<F, SortOrder>, { id: 'asc' }];
      skip: number;
      take: number;
    }) => Promise<T[]>;
    count: (where: W) => Promise<number>;
  },
): Promise<PaginatedResponseDto<T>> {
  const { where, sortFields, fallbackSort, find, count } = options;
  const [rows, total] = await Promise.all([
    find({
      where,
      orderBy: [toOrderBy(query, sortFields, fallbackSort), { id: 'asc' }],
      ...toSkipTake(query),
    }),
    count(where),
  ]);
  return buildPaginated(rows, total, query);
}

// `sortBy` is user input, so it is checked against a per-endpoint whitelist before it can reach
// Prisma's `orderBy`.
export function toOrderBy<F extends string>(
  { sortBy, sortOrder }: Pick<PaginationQueryDto, 'sortBy' | 'sortOrder'>,
  allowed: readonly F[],
  fallback: F,
): Record<F, SortOrder> {
  const field = sortBy ?? fallback;
  if (!allowed.includes(field as F)) {
    throw new DomainException(
      ERROR_CODES.INVALID_SORT_FIELD,
      `Cannot sort by "${field}". Allowed: ${allowed.join(', ')}`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return { [field]: sortOrder } as Record<F, SortOrder>;
}

// Query `limit + 1` rows; the extra one only tells us whether another page exists.
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  toCursor: (last: T) => string,
): CursorPaginatedResponseDto<T> {
  const data = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? toCursor(data[data.length - 1]) : null;
  return { data, meta: { limit, nextCursor } };
}
