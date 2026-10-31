// Prisma model names. Everything with an `organizationId` column is scoped by the tenant
// extension (User and RefreshToken included: only login/refresh bypass it, via the unscoped client).
// Not listed on purpose: Organization (the root), Permission (global catalogue) and
// RolePermission (pure join, no organizationId; reach it through Role).
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'User',
  'RefreshToken',
  'Role',
  'Company',
  'Contact',
  'Lead',
  'Pipeline',
  'PipelineStage',
  'Deal',
  'DealStageHistory',
  'Task',
  'Activity',
  'Notification',
  'AuditLog',
]);

export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  'Company',
  'Contact',
  'Lead',
  'Deal',
]);
