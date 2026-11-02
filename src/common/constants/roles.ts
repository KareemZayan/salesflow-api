// Names of the default roles created for every organization (see prisma/seed). They are flagged
// `isSystem`, cannot be renamed or deleted, and their names are reserved, so a name here always
// means the system role.
export const ADMIN_ROLE_NAME = 'ADMIN';
export const SALES_MANAGER_ROLE_NAME = 'SALES_MANAGER';
export const SALES_REP_ROLE_NAME = 'SALES_REP';

export const SYSTEM_ROLE_NAMES: readonly string[] = [
  ADMIN_ROLE_NAME,
  SALES_MANAGER_ROLE_NAME,
  SALES_REP_ROLE_NAME,
];
