import type { Request } from 'express';
import type { AdminRole } from '../../entities/admin-user.entity.js';

export interface AdminAuditTarget {
  target_type: string;
  target_id: string;
}

export interface AdminAuditActor {
  admin_user_id: string;
  admin_role: AdminRole;
}

const TARGET_KEY = '__adminAuditTarget';
const ACTOR_KEY = '__adminAuditActor';

export function setAdminAuditTarget(
  request: Request,
  target: AdminAuditTarget,
): void {
  (request as unknown as Record<string, unknown>)[TARGET_KEY] = target;
}

export function getAdminAuditTarget(request: Request): AdminAuditTarget | null {
  return (
    ((request as unknown as Record<string, unknown>)[
      TARGET_KEY
    ] as AdminAuditTarget) ?? null
  );
}

export function setAdminAuditActor(
  request: Request,
  actor: AdminAuditActor,
): void {
  (request as unknown as Record<string, unknown>)[ACTOR_KEY] = actor;
}

export function getAdminAuditActor(request: Request): AdminAuditActor | null {
  return (
    ((request as unknown as Record<string, unknown>)[
      ACTOR_KEY
    ] as AdminAuditActor) ?? null
  );
}
