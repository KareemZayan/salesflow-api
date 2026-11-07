import {
  AUDIT_ENTITY_TYPES,
  AUDIT_EVENT_DEFINITIONS,
  AUDIT_EVENTS,
  isAuditEvent,
} from './audit-events';
import {
  assertAuditSafe,
  AUDIT_FIELDS,
  AuditPayloadError,
  diffForAudit,
  FORBIDDEN_AUDIT_KEY,
  MAX_AUDIT_STRING_LENGTH,
} from './audit-fields';

describe('audit event list', () => {
  it('every event names an action and an entity type that has an allowlist', () => {
    for (const event of AUDIT_EVENTS) {
      const { action, entityType } = AUDIT_EVENT_DEFINITIONS[event];
      expect(action).toBeTruthy();
      expect(Object.keys(AUDIT_FIELDS)).toContain(entityType);
    }
    expect(new Set(AUDIT_ENTITY_TYPES)).toEqual(new Set(Object.keys(AUDIT_FIELDS)));
  });

  it('recognises only listed events', () => {
    expect(isAuditEvent('user.deactivated')).toBe(true);
    expect(isAuditEvent('user.exploded')).toBe(false);
    expect(isAuditEvent('toString')).toBe(false);
    expect(isAuditEvent(undefined)).toBe(false);
  });
});

describe('diffForAudit', () => {
  it('keeps only the fields that changed, on both sides', () => {
    expect(
      diffForAudit(
        'User',
        { email: 'a@x.test', firstName: 'A', lastName: 'B', managerId: null },
        { email: 'new@x.test', firstName: 'A', lastName: 'B', managerId: null },
      ),
    ).toEqual({ before: { email: 'a@x.test' }, after: { email: 'new@x.test' } });
  });

  it('returns null when no audited field changed (nothing to record)', () => {
    expect(
      diffForAudit(
        'User',
        { email: 'a@x.test', firstName: 'A' },
        { email: 'a@x.test', firstName: 'A' },
      ),
    ).toBeNull();
  });

  it('a create keeps every allowlisted field of the new state, a delete those of the old one', () => {
    expect(diffForAudit('Role', undefined, { name: 'Support', permissionKeys: ['a:b'] })).toEqual({
      before: null,
      after: { name: 'Support', permissionKeys: ['a:b'] },
    });
    expect(diffForAudit('Task', { assigneeId: 'u1' }, undefined)).toEqual({
      before: { assigneeId: 'u1' },
      after: null,
    });
  });

  it('an event without snapshots (login, password reset) is still recorded', () => {
    expect(diffForAudit('User', undefined, undefined)).toEqual({ before: null, after: null });
  });

  it('treats an equal list as unchanged (permission sets are compared by value)', () => {
    expect(
      diffForAudit('Role', { permissionKeys: ['a:b', 'c:d'] }, { permissionKeys: ['a:b', 'c:d'] }),
    ).toBeNull();
    expect(
      diffForAudit('Role', { permissionKeys: ['a:b'] }, { permissionKeys: ['a:b', 'c:d'] }),
    ).toEqual({ before: { permissionKeys: ['a:b'] }, after: { permissionKeys: ['a:b', 'c:d'] } });
  });

  it('money stays a string and only a real change is kept', () => {
    expect(
      diffForAudit(
        'Deal',
        { amount: '1250.50', currency: 'USD' },
        { amount: '1250.50', currency: 'EUR' },
      ),
    ).toEqual({ before: { currency: 'USD' }, after: { currency: 'EUR' } });
    expect(
      diffForAudit(
        'Deal',
        { amount: '1250.50', currency: 'USD' },
        { amount: '1250.50', currency: 'USD' },
      ),
    ).toBeNull();
    const changed = diffForAudit(
      'Deal',
      { amount: '1.00', currency: 'USD' },
      { amount: '2.00', currency: 'USD' },
    );
    expect(typeof changed?.after?.amount).toBe('string');
  });
});

describe('secrets can never appear in an audit row', () => {
  it('no allowlisted field name looks like a secret', () => {
    for (const fields of Object.values(AUDIT_FIELDS)) {
      for (const field of fields) expect(field).not.toMatch(FORBIDDEN_AUDIT_KEY);
    }
  });

  it('a field outside the allowlist is dropped, whatever it holds', () => {
    const snapshot = {
      email: 'a@x.test',
      passwordHash: '$argon2id$v=19$secret',
      password: 'hunter2',
      refreshToken: 'abc',
      mustChangePassword: true,
      notes: 'free text',
    };
    const diff = diffForAudit('User', undefined, snapshot);
    const stored = JSON.stringify(diff);
    expect(diff?.after).toEqual({ email: 'a@x.test' });
    for (const leaked of [
      'argon2',
      'hunter2',
      'abc',
      'passwordHash',
      'refreshToken',
      'free text',
    ]) {
      expect(stored).not.toContain(leaked);
    }
  });

  it('refuses a forbidden key even if someone adds it to an allowlist', () => {
    expect(() => assertAuditSafe({ passwordHash: 'x' })).toThrow(AuditPayloadError);
    expect(() => assertAuditSafe({ apiToken: 'x' })).toThrow(AuditPayloadError);
    expect(() => assertAuditSafe({ clientSecret: 'x' })).toThrow(AuditPayloadError);
    expect(() => assertAuditSafe({ email: 'a@x.test' })).not.toThrow();
  });

  it('refuses long free text and huge lists instead of storing them', () => {
    expect(() => assertAuditSafe({ name: 'x'.repeat(MAX_AUDIT_STRING_LENGTH + 1) })).toThrow(
      AuditPayloadError,
    );
    expect(() => assertAuditSafe({ permissionKeys: Array(201).fill('a:b') })).toThrow(
      AuditPayloadError,
    );
  });
});
