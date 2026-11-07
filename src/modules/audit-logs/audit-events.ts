import { AuditAction } from '../../generated/prisma/client';

// THE list of audit events (ADR 0014). `AuditService.record` rejects anything else, so an event
// name cannot be mistyped or invented at a call site. The database column is a plain string on
// purpose: a new event is one line here and needs no migration. Each event fixes its coarse
// `action` (the filterable category) and the `entityType` it is about.
export const AUDIT_EVENT_DEFINITIONS = {
  'user.created': { action: AuditAction.CREATE, entityType: 'User' },
  'user.updated': { action: AuditAction.UPDATE, entityType: 'User' },
  'user.deactivated': { action: AuditAction.UPDATE, entityType: 'User' },
  'user.reactivated': { action: AuditAction.UPDATE, entityType: 'User' },
  'user.role_changed': { action: AuditAction.PERMISSION_CHANGE, entityType: 'User' },
  'user.password_reset': { action: AuditAction.UPDATE, entityType: 'User' },
  'role.created': { action: AuditAction.CREATE, entityType: 'Role' },
  'role.updated': { action: AuditAction.UPDATE, entityType: 'Role' },
  'role.deleted': { action: AuditAction.DELETE, entityType: 'Role' },
  'role.permissions_changed': { action: AuditAction.PERMISSION_CHANGE, entityType: 'Role' },
  'organization.updated': { action: AuditAction.UPDATE, entityType: 'Organization' },
  'auth.login': { action: AuditAction.LOGIN, entityType: 'User' },
  'auth.logout': { action: AuditAction.LOGOUT, entityType: 'User' },
  'auth.password_changed': { action: AuditAction.UPDATE, entityType: 'User' },
  'deal.money_changed': { action: AuditAction.UPDATE, entityType: 'Deal' },
  'task.reassigned': { action: AuditAction.UPDATE, entityType: 'Task' },
  'task.deleted': { action: AuditAction.DELETE, entityType: 'Task' },
} as const satisfies Record<string, { action: AuditAction; entityType: string }>;

export type AuditEvent = keyof typeof AUDIT_EVENT_DEFINITIONS;

export const AUDIT_EVENTS = Object.keys(AUDIT_EVENT_DEFINITIONS) as AuditEvent[];

export type AuditEntityType = (typeof AUDIT_EVENT_DEFINITIONS)[AuditEvent]['entityType'];

export const AUDIT_ENTITY_TYPES = [
  ...new Set(Object.values(AUDIT_EVENT_DEFINITIONS).map(({ entityType }) => entityType)),
] as AuditEntityType[];

export const isAuditEvent = (value: unknown): value is AuditEvent =>
  typeof value === 'string' && Object.hasOwn(AUDIT_EVENT_DEFINITIONS, value);
