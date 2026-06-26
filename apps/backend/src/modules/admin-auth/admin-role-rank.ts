import type { AdminRole } from '../../entities/admin-user.entity.js';

export const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  read_only: 0,
  support: 1,
  admin: 2,
  super_admin: 3,
};

export function hasRequiredAdminRole(
  actualRole: AdminRole,
  requiredRoles: AdminRole[],
): boolean {
  const actualRank = ADMIN_ROLE_RANK[actualRole];
  return requiredRoles.some(
    (required) => actualRank >= ADMIN_ROLE_RANK[required],
  );
}

export function canManageAdminRole(
  actorRole: AdminRole,
  targetRole: AdminRole,
): boolean {
  return ADMIN_ROLE_RANK[actorRole] > ADMIN_ROLE_RANK[targetRole];
}
