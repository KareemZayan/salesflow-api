import { MissingTenantContextError, scopeArgs, TenantScopeViolationError } from './tenant-scope';

const ORG = 'org-a';
const scope = { organizationId: ORG, includeDeleted: false };
const noTenant = { organizationId: undefined, includeDeleted: false };

describe('scopeArgs', () => {
  it('leaves non-tenant models untouched', () => {
    const args = { where: { key: 'leads:read' } };
    expect(scopeArgs('Permission', 'findMany', args, noTenant)).toBe(args);
  });

  it('throws when a tenant model is queried without tenant context', () => {
    expect(() => scopeArgs('Task', 'findMany', {}, noTenant)).toThrow(MissingTenantContextError);
    expect(() => scopeArgs('Task', 'create', { data: {} }, noTenant)).toThrow(
      MissingTenantContextError,
    );
  });

  it.each([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
  ])('adds the organization to %s', (operation) => {
    expect(scopeArgs('Task', operation, { where: { id: 't1' } }, scope)).toEqual({
      where: { id: 't1', organizationId: ORG },
    });
  });

  it('creates a where when the caller passed none', () => {
    expect(scopeArgs('Task', 'findMany', undefined, scope)).toEqual({
      where: { organizationId: ORG },
    });
  });

  it('overrides a caller-supplied organizationId in where', () => {
    expect(scopeArgs('Task', 'findMany', { where: { organizationId: 'org-b' } }, scope)).toEqual({
      where: { organizationId: ORG },
    });
  });

  it.each(['update', 'updateMany', 'delete', 'deleteMany'])(
    'scopes the where of %s',
    (operation) => {
      const result = scopeArgs(
        'Task',
        operation,
        { where: { id: 't1' }, data: { title: 'x' } },
        scope,
      );
      expect(result.where).toEqual({ id: 't1', organizationId: ORG });
    },
  );

  it('injects the organization into create and createMany data', () => {
    expect(
      scopeArgs('Task', 'create', { data: { title: 'x', organizationId: 'org-b' } }, scope),
    ).toEqual({ data: { title: 'x', organizationId: ORG } });
    expect(
      scopeArgs('Task', 'createMany', { data: [{ title: 'a' }, { title: 'b' }] }, scope),
    ).toEqual({
      data: [
        { title: 'a', organizationId: ORG },
        { title: 'b', organizationId: ORG },
      ],
    });
  });

  it('scopes upsert: where, and the create branch', () => {
    const args = { where: { id: 't1' }, create: { title: 'x' }, update: { title: 'y' } };
    expect(scopeArgs('Task', 'upsert', args, scope)).toEqual({
      where: { id: 't1', organizationId: ORG },
      create: { title: 'x', organizationId: ORG },
      update: { title: 'y' },
    });
  });

  describe('organizationId writes on update', () => {
    it.each([
      ['update', { data: { organizationId: 'org-b' } }],
      ['updateMany', { data: { organizationId: 'org-b' } }],
      ['update', { data: { organization: { connect: { id: 'org-b' } } } }],
      ['upsert', { create: {}, update: { organizationId: 'org-b' } }],
    ])('rejects %s', (operation, args) => {
      expect(() => scopeArgs('Task', operation, { where: { id: 't1' }, ...args }, scope)).toThrow(
        TenantScopeViolationError,
      );
    });
  });

  describe('soft delete models', () => {
    it.each(['Company', 'Contact', 'Lead', 'Deal'])(
      'hides deleted %s rows on reads and writes',
      (model) => {
        expect(scopeArgs(model, 'findMany', {}, scope).where).toEqual({
          organizationId: ORG,
          deletedAt: null,
        });
        expect(scopeArgs(model, 'update', { where: { id: '1' }, data: {} }, scope).where).toEqual({
          id: '1',
          organizationId: ORG,
          deletedAt: null,
        });
      },
    );

    it('does not add deletedAt to other tenant models', () => {
      expect(scopeArgs('Task', 'findMany', {}, scope).where).toEqual({ organizationId: ORG });
    });

    it('drops the filter only when includeDeleted is on', () => {
      expect(scopeArgs('Lead', 'findMany', {}, { ...scope, includeDeleted: true }).where).toEqual({
        organizationId: ORG,
      });
    });
  });

  it('fails closed on an unknown operation', () => {
    expect(() => scopeArgs('Task', 'somethingNew', {}, scope)).toThrow(TenantScopeViolationError);
  });
});
