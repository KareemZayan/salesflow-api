// Global permission catalogue (`<resource>:<action>`) and the default role mapping.
// Permissions only gate an endpoint; own/team/all visibility is applied separately (Phase 6).

export const PERMISSIONS = {
  'companies:read': 'View companies',
  'companies:create': 'Create companies',
  'companies:update': 'Edit companies',
  'companies:delete': 'Delete companies',
  'contacts:read': 'View contacts',
  'contacts:create': 'Create contacts',
  'contacts:update': 'Edit contacts',
  'contacts:delete': 'Delete contacts',
  'leads:read': 'View leads',
  'leads:create': 'Create leads',
  'leads:update': 'Edit leads',
  'leads:delete': 'Delete leads',
  'leads:convert': 'Convert leads into contacts and deals',
  'deals:read': 'View deals',
  'deals:create': 'Create deals',
  'deals:update': 'Edit deals and move them between stages',
  'deals:delete': 'Delete deals',
  'pipelines:read': 'View pipelines and stages',
  'pipelines:create': 'Create pipelines',
  'pipelines:update': 'Edit pipelines and stages',
  'pipelines:delete': 'Delete pipelines',
  'tasks:read': 'View tasks',
  'tasks:create': 'Create tasks',
  'tasks:update': 'Edit tasks',
  'tasks:delete': 'Delete tasks',
  'activities:read': 'View activity timelines',
  'activities:create': 'Log activities',
  'reports:read': 'View reports',
  'users:read': 'View users',
  'users:create': 'Create users',
  'users:update': 'Edit and deactivate users',
  'roles:read': 'View roles and permissions',
  'roles:manage': 'Manage roles and permissions',
  'audit-logs:read': 'View audit logs',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ROLE_NAMES = {
  ADMIN: 'ADMIN',
  SALES_MANAGER: 'SALES_MANAGER',
  SALES_REP: 'SALES_REP',
} as const;

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

// Day-to-day CRM work shared by managers and reps.
const CRM_WORK: PermissionKey[] = [
  'companies:read',
  'companies:create',
  'companies:update',
  'companies:delete',
  'contacts:read',
  'contacts:create',
  'contacts:update',
  'contacts:delete',
  'leads:read',
  'leads:create',
  'leads:update',
  'leads:delete',
  'leads:convert',
  'deals:read',
  'deals:create',
  'deals:update',
  'deals:delete',
  'tasks:read',
  'tasks:create',
  'tasks:update',
  'tasks:delete',
  'activities:read',
  'activities:create',
  'pipelines:read',
];

export const DEFAULT_ROLES: Record<
  RoleName,
  { description: string; permissions: readonly PermissionKey[] }
> = {
  ADMIN: { description: 'Full access to the organization', permissions: ALL_PERMISSIONS },
  SALES_MANAGER: {
    description: 'Manages a sales team, its pipelines and reports',
    permissions: [
      ...CRM_WORK,
      'pipelines:create',
      'pipelines:update',
      'reports:read',
      'users:read',
    ],
  },
  SALES_REP: { description: 'Works own leads, deals and tasks', permissions: CRM_WORK },
};
