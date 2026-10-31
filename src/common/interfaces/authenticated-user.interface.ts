// What the JWT strategy (Phase 6) puts on `request.user`. `organizationId` is the only tenant source.
export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  role: string;
  permissions: string[];
}
