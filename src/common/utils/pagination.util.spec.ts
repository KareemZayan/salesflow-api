import { buildCursorPage, buildPaginated, toOrderBy, toSkipTake } from './pagination.util';

describe('pagination.util', () => {
  it('computes skip/take from page and limit', () => {
    expect(toSkipTake({ page: 3, limit: 20 })).toEqual({ skip: 40, take: 20 });
  });

  it('builds the paginated envelope with totalPages rounded up', () => {
    expect(buildPaginated(['a'], 41, { page: 2, limit: 20 })).toEqual({
      data: ['a'],
      meta: { page: 2, limit: 20, total: 41, totalPages: 3 },
    });
    expect(buildPaginated([], 0, { page: 1, limit: 20 }).meta.totalPages).toBe(0);
  });

  describe('toOrderBy', () => {
    const allowed = ['createdAt', 'name'] as const;

    it('uses the requested field and direction', () => {
      expect(toOrderBy({ sortBy: 'name', sortOrder: 'asc' }, allowed, 'createdAt')).toEqual({
        name: 'asc',
      });
    });

    it('falls back when no sortBy is given', () => {
      expect(toOrderBy({ sortOrder: 'desc' }, allowed, 'createdAt')).toEqual({ createdAt: 'desc' });
    });

    it('rejects a field outside the whitelist', () => {
      expect(() =>
        toOrderBy({ sortBy: 'passwordHash', sortOrder: 'asc' }, allowed, 'createdAt'),
      ).toThrow(/Cannot sort by "passwordHash"/);
    });
  });

  describe('buildCursorPage', () => {
    it('trims the extra row and exposes the cursor of the last returned one', () => {
      const page = buildCursorPage([{ id: 1 }, { id: 2 }, { id: 3 }], 2, (row) => `c${row.id}`);
      expect(page).toEqual({ data: [{ id: 1 }, { id: 2 }], meta: { limit: 2, nextCursor: 'c2' } });
    });

    it('has no cursor on the last page', () => {
      expect(buildCursorPage([{ id: 1 }], 2, (row) => `c${row.id}`).meta.nextCursor).toBeNull();
    });
  });
});
