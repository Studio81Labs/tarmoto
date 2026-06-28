import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminUser, type AdminRole } from '../../entities/admin-user.entity.js';
import { canManageAdminRole } from '../admin-auth/admin-role-rank.js';
import { revokeAdminSessions } from '../admin-auth/admin-session-revoke.js';
import { runCreateAdmin } from '../../scripts/create-admin-core.js';
import { AdminAuditService } from '../admin/admin-audit.interceptor.js';
import {
  AdminRowDto,
  CreateAdminDto,
  PatchAdminDto,
} from './dto/admin-admins.dto.js';

export interface ActingAdmin {
  id: string;
  role: AdminRole;
}

const ROLE_RANK: Record<AdminRole, number> = {
  read_only: 0,
  support: 1,
  admin: 2,
  super_admin: 3,
};

@Injectable()
export class AdminAdminsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<AdminRowDto[]> {
    const rows = await this.dataSource.getRepository(AdminUser).find({
      order: { created_at: 'DESC' },
    });
    return rows.map((a) => this.toRow(a));
  }

  async create(actor: ActingAdmin, dto: CreateAdminDto): Promise<AdminRowDto> {
    // super_admin may create any role (including peers); non-super_admin must out-rank the target role.
    if (
      actor.role !== 'super_admin' &&
      !canManageAdminRole(actor.role, dto.role)
    ) {
      void this.audit.record({
        event_key: 'admin.admins.create',
        outcome: 'denied',
        method: 'POST',
        path: '/admin/admins',
        admin_user_id: actor.id,
        admin_role: actor.role,
        target_type: 'admin_user',
        target_id: dto.email,
        metadata: { reason: 'insufficient_role' },
      });
      throw new ForbiddenException(
        'Cannot create an admin at or above your role',
      );
    }
    if (
      dto.mode === 'password' &&
      (!dto.password || dto.password.length === 0)
    ) {
      throw new BadRequestException('Password is required for password mode');
    }

    // Normalize email — create-admin-core expects a lowercased email, and
    // normalizing here also makes the duplicate check case-insensitive.
    const email = dto.email.trim().toLowerCase();

    // Explicit 409 guard (fast path): reject if an admin with this email already
    // exists so create() is never an upsert. Without this check, runCreateAdmin
    // (an upsert by email) would silently demote or modify an existing row,
    // bypassing all of patch()'s per-target rank checks and safety rails.
    // The unique index on email is the TOCTOU backstop for concurrent creates.
    const existing = await this.dataSource
      .getRepository(AdminUser)
      .findOne({ where: { email } });
    if (existing) {
      void this.audit.record({
        event_key: 'admin.admins.create',
        outcome: 'denied',
        method: 'POST',
        path: '/admin/admins',
        admin_user_id: actor.id,
        admin_role: actor.role,
        target_type: 'admin_user',
        target_id: email,
        metadata: { reason: 'duplicate_email' },
      });
      throw new ConflictException('An admin with this email already exists');
    }

    const password = dto.mode === 'sso-only' ? null : (dto.password ?? null);

    try {
      const created = await this.dataSource.transaction((manager) =>
        runCreateAdmin(
          manager,
          {
            email,
            role: dto.role,
            ssoOnly: dto.mode === 'sso-only',
            help: false,
          },
          password,
        ),
      );
      const row = await this.dataSource
        .getRepository(AdminUser)
        .findOne({ where: { email: created.email } });
      if (!row) throw new NotFoundException('Admin not found after create');
      return this.toRow(row);
    } catch (err: unknown) {
      // Race backstop: catch the Postgres unique-violation (code 23505) that can
      // slip through if two concurrent creates both pass the pre-check. Throwing
      // ConflictException ensures it never surfaces as a 500 and that the losing
      // request never mutates the already-inserted row.
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === '23505'
      ) {
        void this.audit.record({
          event_key: 'admin.admins.create',
          outcome: 'denied',
          method: 'POST',
          path: '/admin/admins',
          admin_user_id: actor.id,
          admin_role: actor.role,
          target_type: 'admin_user',
          target_id: email,
          metadata: { reason: 'duplicate_email' },
        });
        throw new ConflictException('An admin with this email already exists');
      }
      throw err;
    }
  }

  async patch(
    actor: ActingAdmin,
    id: string,
    dto: PatchAdminDto,
  ): Promise<AdminRowDto> {
    const repo = this.dataSource.getRepository(AdminUser);
    const target = await repo.findOne({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

    const newRole = dto.role ?? target.role;
    const newStatus: 'active' | 'disabled' =
      dto.active === undefined
        ? target.status
        : dto.active
          ? 'active'
          : 'disabled';

    const demoting =
      dto.role !== undefined && ROLE_RANK[newRole] < ROLE_RANK[target.role];
    const disabling = newStatus === 'disabled' && target.status === 'active';

    // Safety rail 1: no self-disable / self-demote. Actor is fixed, so this is
    // safe to check pre-transaction.
    if (actor.id === target.id && (disabling || demoting)) {
      void this.audit.record({
        event_key: 'admin.admins.patch',
        outcome: 'denied',
        method: 'PATCH',
        path: '/admin/admins',
        admin_user_id: actor.id,
        admin_role: actor.role,
        target_type: 'admin_user',
        target_id: id,
        metadata: { reason: 'self_lockout' },
      });
      throw new ForbiddenException(
        'You cannot disable or demote your own account',
      );
    }
    // Rank gate: must out-rank the current target, and (for role changes) the new role.
    // Exception: super_admin may manage peer super_admins; the last-super-admin rail
    // (below) provides the safety net for that case.
    if (
      actor.role !== 'super_admin' &&
      !canManageAdminRole(actor.role, target.role)
    ) {
      void this.audit.record({
        event_key: 'admin.admins.patch',
        outcome: 'denied',
        method: 'PATCH',
        path: '/admin/admins',
        admin_user_id: actor.id,
        admin_role: actor.role,
        target_type: 'admin_user',
        target_id: id,
        metadata: { reason: 'insufficient_role' },
      });
      throw new ForbiddenException(
        'You cannot manage an admin at or above your role',
      );
    }
    if (
      dto.role !== undefined &&
      actor.role !== 'super_admin' &&
      !canManageAdminRole(actor.role, newRole)
    ) {
      void this.audit.record({
        event_key: 'admin.admins.patch',
        outcome: 'denied',
        method: 'PATCH',
        path: '/admin/admins',
        admin_user_id: actor.id,
        admin_role: actor.role,
        target_type: 'admin_user',
        target_id: id,
        metadata: { reason: 'insufficient_role' },
      });
      throw new ForbiddenException(
        'You cannot assign a role at or above your own',
      );
    }

    // Track any denial thrown from inside the transaction so it can be audited
    // AFTER the transaction rolls back. An audit record inside a failing tx
    // would be rolled back along with the write.
    let pendingDenialReason: string | null = null;

    try {
      await this.dataSource.transaction(async (manager) => {
        // Fix 3: Reload and lock the target row inside the transaction to prevent
        // stale-read races — a concurrent super_admin could promote the target
        // between the pre-tx read above and this write, letting a lower-ranked
        // actor demote or disable a now-peer.
        const fresh = await manager.getRepository(AdminUser).findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!fresh) throw new NotFoundException('Admin not found');

        // Recompute derived values against the fresh (locked) row.
        const freshNewRole = dto.role ?? fresh.role;
        const freshNewStatus: 'active' | 'disabled' =
          dto.active === undefined
            ? fresh.status
            : dto.active
              ? 'active'
              : 'disabled';
        const freshDemoting =
          dto.role !== undefined &&
          ROLE_RANK[freshNewRole] < ROLE_RANK[fresh.role];
        const freshDisabling =
          freshNewStatus === 'disabled' && fresh.status === 'active';

        // Re-run rank gates against the fresh (possibly promoted) role.
        if (
          actor.role !== 'super_admin' &&
          !canManageAdminRole(actor.role, fresh.role)
        ) {
          pendingDenialReason = 'insufficient_role';
          throw new ForbiddenException(
            'You cannot manage an admin at or above your role',
          );
        }
        if (
          dto.role !== undefined &&
          actor.role !== 'super_admin' &&
          !canManageAdminRole(actor.role, freshNewRole)
        ) {
          pendingDenialReason = 'insufficient_role';
          throw new ForbiddenException(
            'You cannot assign a role at or above your own',
          );
        }

        // Safety rail 2: protect the last active super_admin.
        // Apply ONLY when the target is currently active — a disabled super_admin
        // being demoted or cleaned up cannot reduce the active count, so blocking
        // it here would prevent legitimate maintenance.
        // Uses a pessimistic_write lock so concurrent patch transactions serialize
        // on the super_admin rows, preventing the write-skew where two concurrent
        // patches each see count=2 and both commit → zero active super_admins.
        if (
          fresh.role === 'super_admin' &&
          fresh.status === 'active' &&
          (freshDisabling || (freshDemoting && freshNewRole !== 'super_admin'))
        ) {
          // Lock the active super_admin rows (not a COUNT aggregate — FOR UPDATE
          // on a COUNT is a Postgres error). Counting in application code after
          // locking the rows still serializes concurrent transactions.
          const activeSupers = await manager
            .getRepository(AdminUser)
            .createQueryBuilder('a')
            .select('a.id')
            .setLock('pessimistic_write')
            .where('a.role = :role', { role: 'super_admin' })
            .andWhere('a.status = :status', { status: 'active' })
            .getMany();
          if (activeSupers.length <= 1) {
            pendingDenialReason = 'last_super_admin';
            throw new ConflictException(
              'Cannot disable or demote the last super_admin',
            );
          }
        }

        await manager
          .getRepository(AdminUser)
          .update({ id }, { role: freshNewRole, status: freshNewStatus });
        if (freshDisabling || freshDemoting) {
          await revokeAdminSessions(manager, id);
        }
      });
    } catch (err: unknown) {
      if (pendingDenialReason !== null) {
        void this.audit.record({
          event_key: 'admin.admins.patch',
          outcome: 'denied',
          method: 'PATCH',
          path: '/admin/admins',
          admin_user_id: actor.id,
          admin_role: actor.role,
          target_type: 'admin_user',
          target_id: id,
          metadata: { reason: pendingDenialReason },
        });
      }
      throw err;
    }

    const updated = await repo.findOne({ where: { id } });
    return this.toRow(updated!);
  }

  private toRow(a: AdminUser): AdminRowDto {
    return {
      id: a.id,
      email: a.email,
      role: a.role,
      status: a.status,
      last_login_at: a.last_login_at?.toISOString() ?? null,
      created_at: a.created_at.toISOString(),
    };
  }
}
