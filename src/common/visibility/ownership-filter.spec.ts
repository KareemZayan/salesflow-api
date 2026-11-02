import { HttpException } from '@nestjs/common';
import { applyVisibility, assertVisible, ownerWhere } from './ownership-filter';
import { VisibilityScope } from './visibility.types';

const all: VisibilityScope = { kind: 'all' };
const team: VisibilityScope = { kind: 'owners', ownerIds: ['me', 'report'] };

describe('ownership filter', () => {
  it('ownerWhere is empty for all and an IN list otherwise, on any field', () => {
    expect(ownerWhere(all)).toEqual({});
    expect(ownerWhere(team)).toEqual({ ownerId: { in: ['me', 'report'] } });
    expect(ownerWhere(team, 'assigneeId')).toEqual({ assigneeId: { in: ['me', 'report'] } });
  });

  it('applyVisibility ANDs the scope with the caller filter and never overwrites it', () => {
    // A client-supplied ownerId filter must not replace the visibility condition.
    const where = { ownerId: 'someone-else', status: 'NEW' };
    expect(applyVisibility(where, team)).toEqual({
      AND: [where, { ownerId: { in: ['me', 'report'] } }],
    });
    expect(applyVisibility(undefined, team)).toEqual({
      AND: [{ ownerId: { in: ['me', 'report'] } }],
    });
  });

  it('applyVisibility keeps the caller filter for admins', () => {
    expect(applyVisibility({ status: 'NEW' }, all)).toEqual({ AND: [{ status: 'NEW' }, {}] });
  });

  it('assertVisible answers 404 for foreign and ownerless records, passes for admins', () => {
    expect(() => assertVisible(team, 'report')).not.toThrow();
    expect(() => assertVisible(all, null)).not.toThrow();
    for (const owner of ['stranger', null]) {
      try {
        assertVisible(team, owner);
        throw new Error('expected a failure');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(404);
      }
    }
  });
});
