import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '../../entities/admin-user.entity.js';

export const ADMIN_ROLES_KEY = 'admin_roles';

export const AdminRoles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
