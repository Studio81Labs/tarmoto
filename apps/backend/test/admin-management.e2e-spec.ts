import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Request } from 'express';
import { AdminAdminsController } from '../src/modules/admin-admins/admin-admins.controller.js';
import { AdminAdminsService } from '../src/modules/admin-admins/admin-admins.service.js';
import { ADMIN_ROLES_KEY } from '../src/modules/admin-auth/admin-role.decorator.js';
import { hasRequiredAdminRole } from '../src/modules/admin-auth/admin-role-rank.js';
import type { AdminRole } from '../src/entities/admin-user.entity.js';

/**
 * Admin-management gating integration test
 *
 * Verifies that GET /api/v1/admin/admins is gated @AdminRoles('admin'):
 *   - read_only or support session  → 403
 *   - admin / super_admin session   → 200
 *
 * NOTE: This is an in-process integration test (no live DB required).
 * A full e2e spec mirroring admin-auth.e2e-spec.ts can be run when a DB
 * harness is available via `pnpm db:up && pnpm db:migrate`.
 *
 * The TestGuard shim reads an `x-test-admin-role` header, attaches a fake
 * adminUser, and then enforces the real @AdminRoles metadata — identical
 * semantics to InternalGuard.assertRole without the JWT/DB dependency.
 */

class TestGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { adminUser?: { id: string; role: AdminRole } }>();
    const roleHeader = req.headers['x-test-admin-role'] as string | undefined;
    if (!roleHeader) return true; // public path — no session needed

    req.adminUser = { id: 'test-id', role: roleHeader as AdminRole };

    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) return true;
    if (hasRequiredAdminRole(roleHeader as AdminRole, requiredRoles))
      return true;
    throw new ForbiddenException('Admin role not allowed');
  }
}

describe('Admin-management gating (@AdminRoles integration)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const mockService = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      patch: jest.fn().mockResolvedValue({ id: 'a1' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAdminsController],
      providers: [
        { provide: AdminAdminsService, useValue: mockService },
        Reflector,
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) => new TestGuard(reflector),
          inject: [Reflector],
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  }, 15_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/v1/admin/admins with read_only session → 403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/admins')
      .set('x-test-admin-role', 'read_only')
      .expect(403);
  });

  it('GET /api/v1/admin/admins with support session → 403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/admins')
      .set('x-test-admin-role', 'support')
      .expect(403);
  });

  it('GET /api/v1/admin/admins with admin session → 200', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/admins')
      .set('x-test-admin-role', 'admin')
      .expect(200);
  });

  it('GET /api/v1/admin/admins with super_admin session → 200', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/admins')
      .set('x-test-admin-role', 'super_admin')
      .expect(200);
  });
});
