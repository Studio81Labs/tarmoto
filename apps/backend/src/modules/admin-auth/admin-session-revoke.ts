import { EntityManager, In, IsNull } from 'typeorm';
import { AdminSession } from '../../entities/admin-session.entity.js';
import { AdminRefreshToken } from '../../entities/admin-refresh-token.entity.js';

/**
 * Revoke ALL of an admin's active sessions and their refresh tokens.
 * Shared by the create-admin CLI core (credential rotation / reactivation)
 * and the admin-admins service (disable / demote).
 */
export async function revokeAdminSessions(
  manager: EntityManager,
  adminUserId: string,
): Promise<void> {
  const now = new Date();
  const sessions = await manager
    .getRepository(AdminSession)
    .find({ where: { admin_user_id: adminUserId }, select: { id: true } });

  await manager
    .getRepository(AdminSession)
    .update(
      { admin_user_id: adminUserId, revoked_at: IsNull() },
      { revoked_at: now },
    );

  if (sessions.length > 0) {
    await manager
      .getRepository(AdminRefreshToken)
      .update(
        { session_id: In(sessions.map((s) => s.id)), revoked_at: IsNull() },
        { revoked_at: now },
      );
  }
}
