import type { Request } from 'express';

export interface AdminAuditTarget {
  target_type: string;
  target_id: string;
}

const KEY = '__adminAuditTarget';

export function setAdminAuditTarget(
  request: Request,
  target: AdminAuditTarget,
): void {
  (request as Record<string, unknown>)[KEY] = target;
}

export function getAdminAuditTarget(request: Request): AdminAuditTarget | null {
  return (
    ((request as Record<string, unknown>)[KEY] as AdminAuditTarget) ?? null
  );
}
