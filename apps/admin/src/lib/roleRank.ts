import type { AdminRole } from "../auth/adminAuthApi.js";

export type { AdminRole };

/**
 * Numeric rank for each admin role. Higher = more privileged.
 * Shared between route access gating (App.tsx) and admin management
 * permission checks (AdministratorsScreen.tsx).
 */
export const ROLE_RANK: Record<AdminRole, number> = {
  read_only: 1,
  support: 2,
  admin: 3,
  super_admin: 4,
};

/**
 * Returns true when `role` meets or exceeds the required `minRole`.
 * Use this to gate sidebar nav items and screen rendering.
 */
export function canAccess(role: AdminRole, minRole: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}
