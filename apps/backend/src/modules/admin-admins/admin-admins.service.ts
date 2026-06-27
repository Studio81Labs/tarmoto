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
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(): Promise<AdminRowDto[]> {
    const rows = await this.dataSource.getRepository(AdminUser).find({
      order: { created_at: 'DESC' },
    });
    return rows.map((a) => this.toRow(a));
  }

  async create(actor: ActingAdmin, dto: CreateAdminDto): Promise<AdminRowDto> {
    if (!canManageAdminRole(actor.role, dto.role)) {
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
    const password = dto.mode === 'sso-only' ? null : (dto.password ?? null);

    const created = await this.dataSource.transaction((manager) =>
      runCreateAdmin(
        manager,
        {
          email: dto.email,
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

    // Safety rail 1: no self-disable / self-demote.
    if (actor.id === target.id && (disabling || demoting)) {
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
      throw new ForbiddenException(
        'You cannot manage an admin at or above your role',
      );
    }
    if (
      dto.role !== undefined &&
      actor.role !== 'super_admin' &&
      !canManageAdminRole(actor.role, newRole)
    ) {
      throw new ForbiddenException(
        'You cannot assign a role at or above your own',
      );
    }
    // Safety rail 2: protect the last active super_admin.
    if (
      target.role === 'super_admin' &&
      (disabling || (demoting && newRole !== 'super_admin'))
    ) {
      const activeSupers = await repo.count({
        where: { role: 'super_admin', status: 'active' },
      });
      if (activeSupers <= 1) {
        throw new ConflictException(
          'Cannot disable or demote the last super_admin',
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(AdminUser)
        .update({ id }, { role: newRole, status: newStatus });
      if (disabling || demoting) {
        await revokeAdminSessions(manager, id);
      }
    });

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
