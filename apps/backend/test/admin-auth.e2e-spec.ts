import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { AdminUser } from '../src/entities/admin-user.entity.js';
import { AppDataSource } from '../src/data-source.js';
import { hashAdminPassword } from '../src/modules/admin-auth/admin-password.js';

/**
 * Admin auth + guard integration (e2e)
 *
 * Verifies the two core security properties introduced in Task 11:
 *   1. GET /admin/metrics with no session → 401 (InternalGuard rejects).
 *   2. POST /admin/auth/login + cookie → GET /admin/metrics → 200.
 *
 * Prerequisites: `pnpm db:up && pnpm db:migrate` before running
 * `pnpm --filter @tarmoto/backend test:e2e`.
 */

const E2E_ADMIN_EMAIL = 'e2e-admin@tarmoto.app';
const E2E_ADMIN_PASSWORD = 'e2e-password-123!';

describe('Admin auth + InternalGuard (e2e)', () => {
  let app: INestApplication<App>;
  let seedDataSource: DataSource;
  let adminUserId: string;

  beforeAll(async () => {
    // Seed via a dedicated connection so we don't conflict with the app's
    // TypeORM DataSource (which is initialised inside AppModule below).
    seedDataSource = new DataSource(AppDataSource.options);
    await seedDataSource.initialize();

    const passwordHash = await hashAdminPassword(E2E_ADMIN_PASSWORD);
    const result = await seedDataSource
      .createQueryBuilder()
      .insert()
      .into(AdminUser)
      .values({
        email: E2E_ADMIN_EMAIL,
        password_hash: passwordHash,
        role: 'admin',
        status: 'active',
      })
      .returning('id')
      .execute();
    adminUserId = result.raw[0].id as string;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    if (adminUserId && seedDataSource?.isInitialized) {
      await seedDataSource.query(
        `DELETE FROM admin_sessions WHERE admin_user_id = $1`,
        [adminUserId],
      );
      await seedDataSource.query(
        `DELETE FROM admin_refresh_tokens WHERE admin_user_id = $1`,
        [adminUserId],
      );
      await seedDataSource.query(
        `DELETE FROM admin_audit_logs WHERE admin_user_id = $1`,
        [adminUserId],
      );
      await seedDataSource.query(`DELETE FROM admin_users WHERE id = $1`, [
        adminUserId,
      ]);
    }
    await app?.close();
    if (seedDataSource?.isInitialized) {
      await seedDataSource.destroy();
    }
  }, 30_000);

  it('GET /admin/metrics without a session returns 401', async () => {
    await request(app.getHttpServer()).get('/admin/metrics').expect(401);
  });

  it('POST /admin/auth/login then GET /admin/metrics with the cookie returns 200', async () => {
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD })
      .expect(201);

    const rawCookie = login.headers['set-cookie'] as
      | string
      | string[]
      | undefined;
    expect(rawCookie).toBeDefined();
    const cookieArr = Array.isArray(rawCookie)
      ? rawCookie
      : [rawCookie as string];
    const accessCookie = cookieArr.find((c) =>
      c.startsWith('tarmoto_admin_access='),
    );
    expect(accessCookie).toBeDefined();

    await request(app.getHttpServer())
      .get('/admin/metrics')
      .set('Cookie', cookieArr.join('; '))
      .expect(200);
  });
});
