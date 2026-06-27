# Admin Console — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tarmoto admin identity/RBAC foundation (separate admin users, sessions, rotating refresh tokens, SSO + dev password login, role-rank guard, audit log) plus a Vite + React admin SPA shell with login and an Overview screen.

**Architecture:** A new NestJS `admin-auth` + `admin` module set adds a separate `admin_users` identity (not app `users`), cookie-based JWT access + rotating refresh sessions, and an `InternalGuard` that authenticates `/admin/*` requests and enforces a 4-tier role rank via `@AdminRoles`. A new Vite + React 19 SPA (`apps/admin`, mirroring `apps/poc-sensor` scaffolding and the nexcue/tabletap admin pattern) talks to those endpoints through a typed `openapi-fetch` client with transparent 401→refresh→replay.

**Tech Stack:** NestJS 11, TypeORM + PostGIS, `@nestjs/jwt`, bcrypt, Jest (backend); Vite 8, React 19, TanStack Query v5, `openapi-fetch` + `openapi-react-query`, Vitest + Testing Library (admin SPA); Cloudflare Worker deploy.

## Global Constraints

- **TypeScript strict mode** everywhere. Backend ESM imports use explicit `.js` extensions (e.g. `import { User } from './user.entity.js'`).
- **Entity registration is a dual list:** every new entity AND migration must be added to BOTH `apps/backend/src/modules/database/database.module.ts` (runtime) AND `apps/backend/src/data-source.ts` (CLI). Drift silently breaks schema. (See memory: `datasource-entity-list-split`.)
- **Migrations are hand-written**, named `apps/backend/src/migrations/<unixMillis>-<Name>.ts` with class `<Name><unixMillis>`, `up`/`down` raw SQL. Run via `pnpm db:migrate` (builds, then `typeorm migration:run -d dist/data-source.js`).
- **Env vars use the `TARMOTO_` prefix** (carve-outs: `PORT`, `NODE_ENV`). Read via `ConfigService` (`ConfigModule` is global).
- **Backend stores metric units only.** (Not exercised in Phase 1, but no unit conversion may be persisted.)
- **No broad try/catch, no silent fallbacks** that hide failures (AGENTS.md). Guard failures must surface as 401/403.
- **Conventional commits**, scope required, from the allowed set: `backend`, `companion`, `admin` is NOT a valid scope — use `backend` for backend work and `cross` for the new `apps/admin` app + root wiring. PR title form `<type>(<scope>): <desc>`.
- **Admins are a separate identity** (`admin_users`), never a flag on `users`.
- Admin session JWTs are signed with a **separate secret** `TARMOTO_ADMIN_SESSION_SECRET` (isolated from the user `TARMOTO_JWT_SECRET`), so leaking one token class never forges the other.
- Run a single backend test with: `pnpm --filter @tarmoto/backend test -- --testPathPattern=<pattern>`.
- Run a single admin SPA test with: `pnpm --filter @tarmoto/admin test -- <pattern>`.

---

## File Structure

**Backend (`apps/backend/src/`)**

- `entities/admin-user.entity.ts`, `entities/admin-session.entity.ts`, `entities/admin-refresh-token.entity.ts`, `entities/admin-audit-log.entity.ts` — new TypeORM entities.
- `entities/index.ts` — add exports.
- `migrations/<ts>-AddAdminConsoleFoundation.ts` — tables + indexes.
- `modules/database/database.module.ts` + `data-source.ts` — register entities + migration (both files).
- `modules/admin-auth/` — `admin-auth.constants.ts`, `admin-access-token-payload.ts`, `admin-session-secret.ts`, `admin-role-rank.ts`, `admin-role.decorator.ts`, `admin-auth.cookies.ts`, `admin-password.ts`, `admin-auth.service.ts`, `admin-auth.controller.ts`, `admin-github-sso.ts`, `admin-auth.module.ts`, `dto/*`.
- `modules/admin/` — `internal.guard.ts`, `admin-audit.interceptor.ts`, `admin-audit-context.ts`, `admin-metrics.controller.ts`, `admin-metrics.service.ts`, `admin.module.ts`, `dto/*`.
- `scripts/demo-seed/` — add `seedAdminUsers`.

**Admin SPA (`apps/admin/`)**

- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `wrangler.jsonc`, `vitest` config (in vite config).
- `src/main.tsx`, `src/styles.css`, `src/globals.d.ts`.
- `src/data/apiClient.ts`, `src/data/queryClient.ts`, `src/data/useAdminMetrics.ts`.
- `src/auth/adminAuthApi.ts`, `src/auth/useAdminAuth.ts`, `src/auth/LoginScreen.tsx`.
- `src/app/App.tsx`, `src/app/routes.ts`.
- `src/components/layout/Sidebar.tsx`, `src/components/layout/TopBar.tsx`.
- `src/screens/OverviewScreen.tsx`.
- `src/test/setup.ts`.

**Root**

- `package.json` — add `admin:dev`, `admin:build`, `admin:test` scripts.

---

## Backend Tasks

### Task 1: Admin entities + migration + dual registration

**Files:**

- Create: `apps/backend/src/entities/admin-user.entity.ts`, `admin-session.entity.ts`, `admin-refresh-token.entity.ts`, `admin-audit-log.entity.ts`
- Modify: `apps/backend/src/entities/index.ts`
- Create: `apps/backend/src/migrations/1751000000000-AddAdminConsoleFoundation.ts`
- Modify: `apps/backend/src/modules/database/database.module.ts`, `apps/backend/src/data-source.ts`
- Test: `apps/backend/src/entities/admin-user.entity.spec.ts` (repository integration smoke test)

**Interfaces:**

- Produces: `AdminUser` (`id`, `email`, `password_hash: string | null`, `role: AdminRole`, `status: AdminUserStatus`, `sso_provider: string | null`, `sso_subject: string | null`, `last_login_at: Date | null`, `created_at`, `updated_at`); `AdminSession` (`id`, `admin_user_id`, `expires_at`, `revoked_at`, `last_seen_at`, `created_at`); `AdminRefreshToken` (`id`, `session_id`, `token_hash`, `expires_at`, `revoked_at`, `replaced_by_token_id`, `last_used_at`, `created_at`); `AdminAuditLog` (`id`, `admin_user_id`, `admin_role`, `event_key`, `outcome`, `method`, `path`, `target_type`, `target_id`, `metadata`, `created_at`).
- Produces types: `AdminRole = 'read_only' | 'support' | 'admin' | 'super_admin'`, `AdminUserStatus = 'active' | 'disabled'`.

- [ ] **Step 1: Write the admin-user entity**

Create `apps/backend/src/entities/admin-user.entity.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type AdminRole = "read_only" | "support" | "admin" | "super_admin";
export type AdminUserStatus = "active" | "disabled";

@Entity("admin_users")
@Index("uq_admin_users_email", ["email"], { unique: true })
@Index("uq_admin_users_sso", ["sso_provider", "sso_subject"], {
  unique: true,
  where: "sso_provider IS NOT NULL AND sso_subject IS NOT NULL",
})
@Index("idx_admin_users_role_status", ["role", "status"])
export class AdminUser {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  // Null = SSO-only account (password login disabled). select:false so it
  // never leaks through a default find().
  @Column({ type: "varchar", length: 255, nullable: true, select: false })
  password_hash!: string | null;

  @Column({ type: "varchar", length: 20, default: "read_only" })
  role!: AdminRole;

  @Column({ type: "varchar", length: 20, default: "active" })
  status!: AdminUserStatus;

  @Column({ type: "varchar", length: 32, nullable: true })
  sso_provider!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  sso_subject!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  last_login_at!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}
```

- [ ] **Step 2: Write the admin-session entity**

Create `apps/backend/src/entities/admin-session.entity.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("admin_sessions")
@Index("idx_admin_sessions_user", ["admin_user_id"])
export class AdminSession {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  admin_user_id!: string;

  @Column({ type: "timestamptz" })
  expires_at!: Date;

  @Column({ type: "timestamptz", nullable: true })
  revoked_at!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  last_seen_at!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
```

- [ ] **Step 3: Write the admin-refresh-token entity**

Create `apps/backend/src/entities/admin-refresh-token.entity.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("admin_refresh_tokens")
@Index("uq_admin_refresh_token_hash", ["token_hash"], { unique: true })
@Index("idx_admin_refresh_session", ["session_id"])
export class AdminRefreshToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  session_id!: string;

  @Column({ type: "varchar", length: 128 })
  token_hash!: string;

  @Column({ type: "timestamptz" })
  expires_at!: Date;

  @Column({ type: "timestamptz", nullable: true })
  revoked_at!: Date | null;

  @Column({ type: "uuid", nullable: true })
  replaced_by_token_id!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  last_used_at!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
```

- [ ] **Step 4: Write the admin-audit-log entity**

Create `apps/backend/src/entities/admin-audit-log.entity.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { AdminRole } from "./admin-user.entity.js";

@Entity("admin_audit_logs")
@Index("idx_admin_audit_created", ["created_at"])
@Index("idx_admin_audit_actor", ["admin_user_id"])
export class AdminAuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true })
  admin_user_id!: string | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  admin_role!: AdminRole | null;

  @Column({ type: "varchar", length: 64 })
  event_key!: string;

  @Column({ type: "varchar", length: 16 })
  outcome!: "allowed" | "denied";

  @Column({ type: "varchar", length: 10 })
  method!: string;

  @Column({ type: "varchar", length: 512 })
  path!: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  target_type!: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  target_id!: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;
}
```

- [ ] **Step 5: Export the entities**

In `apps/backend/src/entities/index.ts`, add (matching the existing export style):

```typescript
export { AdminUser } from "./admin-user.entity.js";
export type { AdminRole, AdminUserStatus } from "./admin-user.entity.js";
export { AdminSession } from "./admin-session.entity.js";
export { AdminRefreshToken } from "./admin-refresh-token.entity.js";
export { AdminAuditLog } from "./admin-audit-log.entity.js";
```

- [ ] **Step 6: Write the migration**

Create `apps/backend/src/migrations/1751000000000-AddAdminConsoleFoundation.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAdminConsoleFoundation1751000000000 implements MigrationInterface {
  name = "AddAdminConsoleFoundation1751000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE admin_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(20) NOT NULL DEFAULT 'read_only',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        sso_provider VARCHAR(32),
        sso_subject VARCHAR(255),
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_admin_users_email ON admin_users (email);
      CREATE UNIQUE INDEX uq_admin_users_sso ON admin_users (sso_provider, sso_subject)
        WHERE sso_provider IS NOT NULL AND sso_subject IS NOT NULL;
      CREATE INDEX idx_admin_users_role_status ON admin_users (role, status);

      CREATE TABLE admin_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_admin_sessions_user ON admin_sessions (admin_user_id);

      CREATE TABLE admin_refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        replaced_by_token_id UUID,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_admin_refresh_token_hash ON admin_refresh_tokens (token_hash);
      CREATE INDEX idx_admin_refresh_session ON admin_refresh_tokens (session_id);

      CREATE TABLE admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id UUID,
        admin_role VARCHAR(20),
        event_key VARCHAR(64) NOT NULL,
        outcome VARCHAR(16) NOT NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(512) NOT NULL,
        target_type VARCHAR(64),
        target_id VARCHAR(128),
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_admin_audit_created ON admin_audit_logs (created_at);
      CREATE INDEX idx_admin_audit_actor ON admin_audit_logs (admin_user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS admin_audit_logs CASCADE;
      DROP TABLE IF EXISTS admin_refresh_tokens CASCADE;
      DROP TABLE IF EXISTS admin_sessions CASCADE;
      DROP TABLE IF EXISTS admin_users CASCADE;
    `);
  }
}
```

- [ ] **Step 7: Register entities + migration in BOTH lists**

In `apps/backend/src/modules/database/database.module.ts`: add the four entities to the imports from `entities/index.js` and to the `entities` array; add `AddAdminConsoleFoundation1751000000000` to its migrations import + array. Do the identical edit in `apps/backend/src/data-source.ts` (it imports entities individually and keeps its own `entities` + `migrations` arrays). Match existing ordering (append at end).

- [ ] **Step 8: Write the repository smoke test**

Create `apps/backend/src/entities/admin-user.entity.spec.ts`:

```typescript
import { DataSource } from "typeorm";
import { AdminUser } from "./admin-user.entity.js";

describe("AdminUser entity metadata", () => {
  it("maps to the admin_users table with the expected columns", () => {
    const ds = new DataSource({
      type: "postgres",
      entities: [AdminUser],
    });
    const meta = ds.getMetadata(AdminUser);
    expect(meta.tableName).toBe("admin_users");
    const columns = meta.columns.map((c) => c.databaseName);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "email",
        "password_hash",
        "role",
        "status",
        "sso_provider",
        "sso_subject",
        "last_login_at",
      ]),
    );
  });
});
```

- [ ] **Step 9: Run the test (expect fail, then pass)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-user.entity`
Expected first run: FAIL (entity not found / not exported). After Steps 1–7 it PASSES.

- [ ] **Step 10: Apply the migration against the dev DB**

Run: `pnpm db:up && pnpm db:migrate`
Expected: migration `AddAdminConsoleFoundation1751000000000` runs; no errors. Verify with `docker compose -f infra/docker/docker-compose.yml exec -T postgres psql -U tarmoto -d tarmoto -c '\dt admin_*'` → lists the four tables.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/entities apps/backend/src/migrations apps/backend/src/modules/database/database.module.ts apps/backend/src/data-source.ts
git commit -m "feat(backend): add admin console identity + audit entities and migration"
```

---

### Task 2: Role rank + roles decorator (pure functions)

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-role-rank.ts`, `admin-role.decorator.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-role-rank.spec.ts`

**Interfaces:**

- Consumes: `AdminRole` from `entities/admin-user.entity.js`.
- Produces: `ADMIN_ROLE_RANK: Record<AdminRole, number>`; `hasRequiredAdminRole(actual: AdminRole, required: AdminRole[]): boolean`; `canManageAdminRole(actor: AdminRole, target: AdminRole): boolean`; `ADMIN_ROLES_KEY = 'admin_roles'`; `AdminRoles(...roles: AdminRole[])` decorator.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin-auth/admin-role-rank.spec.ts`:

```typescript
import { hasRequiredAdminRole, canManageAdminRole } from "./admin-role-rank.js";

describe("admin role rank", () => {
  it("allows a higher rank to satisfy a lower requirement", () => {
    expect(hasRequiredAdminRole("admin", ["support"])).toBe(true);
  });

  it("rejects a lower rank for a higher requirement", () => {
    expect(hasRequiredAdminRole("support", ["admin"])).toBe(false);
  });

  it("passes if any required role is satisfied", () => {
    expect(hasRequiredAdminRole("support", ["admin", "support"])).toBe(true);
  });

  it("only lets an actor manage strictly lower roles", () => {
    expect(canManageAdminRole("super_admin", "admin")).toBe(true);
    expect(canManageAdminRole("admin", "admin")).toBe(false);
    expect(canManageAdminRole("admin", "super_admin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-role-rank`
Expected: FAIL ("Cannot find module './admin-role-rank.js'").

- [ ] **Step 3: Implement**

Create `apps/backend/src/modules/admin-auth/admin-role-rank.ts`:

```typescript
import type { AdminRole } from "../../entities/admin-user.entity.js";

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
```

Create `apps/backend/src/modules/admin-auth/admin-role.decorator.ts`:

```typescript
import { SetMetadata } from "@nestjs/common";
import type { AdminRole } from "../../entities/admin-user.entity.js";

export const ADMIN_ROLES_KEY = "admin_roles";

export const AdminRoles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-role-rank`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-role-rank.ts apps/backend/src/modules/admin-auth/admin-role.decorator.ts apps/backend/src/modules/admin-auth/admin-role-rank.spec.ts
git commit -m "feat(backend): add admin role-rank helpers and @AdminRoles decorator"
```

---

### Task 3: Constants, token payload, session secret resolver

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-auth.constants.ts`, `admin-access-token-payload.ts`, `admin-session-secret.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-session-secret.spec.ts`

**Interfaces:**

- Produces: constants `ADMIN_ACCESS_COOKIE='tarmoto_admin_access'`, `ADMIN_REFRESH_COOKIE='tarmoto_admin_refresh'`, `ADMIN_SSO_STATE_COOKIE='tarmoto_admin_sso_state'`, `ADMIN_ACCESS_TOKEN_SCOPE='admin_access'`, `ADMIN_ACCESS_TOKEN_SECONDS=540`, `ADMIN_REFRESH_TOKEN_SECONDS=2592000`.
- Produces: `interface AdminAccessTokenPayload { sub: string; sid: string; scope: string }`.
- Produces: `resolveAdminSessionSecret(config: ConfigService): string`.

- [ ] **Step 1: Write constants + payload**

Create `apps/backend/src/modules/admin-auth/admin-auth.constants.ts`:

```typescript
export const ADMIN_ACCESS_COOKIE = "tarmoto_admin_access";
export const ADMIN_REFRESH_COOKIE = "tarmoto_admin_refresh";
export const ADMIN_SSO_STATE_COOKIE = "tarmoto_admin_sso_state";

export const ADMIN_ACCESS_TOKEN_SCOPE = "admin_access";

// 9 minutes access, 30 days refresh.
export const ADMIN_ACCESS_TOKEN_SECONDS = 9 * 60;
export const ADMIN_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
```

Create `apps/backend/src/modules/admin-auth/admin-access-token-payload.ts`:

```typescript
export interface AdminAccessTokenPayload {
  sub: string; // admin_user id
  sid: string; // admin_session id
  scope: string; // ADMIN_ACCESS_TOKEN_SCOPE
}
```

- [ ] **Step 2: Write the failing secret-resolver test**

Create `apps/backend/src/modules/admin-auth/admin-session-secret.spec.ts`:

```typescript
import { ConfigService } from "@nestjs/config";
import { resolveAdminSessionSecret } from "./admin-session-secret.js";

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe("resolveAdminSessionSecret", () => {
  it("returns the configured secret", () => {
    const secret = resolveAdminSessionSecret(
      configWith({ TARMOTO_ADMIN_SESSION_SECRET: "super-secret-value-1234" }),
    );
    expect(secret).toBe("super-secret-value-1234");
  });

  it("falls back to a dev secret outside production", () => {
    const secret = resolveAdminSessionSecret(
      configWith({ NODE_ENV: "development" }),
    );
    expect(secret.length).toBeGreaterThan(0);
  });

  it("throws when unset in production", () => {
    expect(() =>
      resolveAdminSessionSecret(configWith({ NODE_ENV: "production" })),
    ).toThrow(/TARMOTO_ADMIN_SESSION_SECRET/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-session-secret`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the resolver**

Create `apps/backend/src/modules/admin-auth/admin-session-secret.ts`:

```typescript
import { ConfigService } from "@nestjs/config";

const DEV_FALLBACK_SECRET = "dev-only-admin-secret-do-not-use-in-production";

export function resolveAdminSessionSecret(config: ConfigService): string {
  const secret = config.get<string>("TARMOTO_ADMIN_SESSION_SECRET");
  if (secret && secret.trim().length > 0) {
    return secret.trim();
  }
  if (config.get<string>("NODE_ENV") === "production") {
    throw new Error("TARMOTO_ADMIN_SESSION_SECRET must be set in production");
  }
  return DEV_FALLBACK_SECRET;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-session-secret`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-auth.constants.ts apps/backend/src/modules/admin-auth/admin-access-token-payload.ts apps/backend/src/modules/admin-auth/admin-session-secret.ts apps/backend/src/modules/admin-auth/admin-session-secret.spec.ts
git commit -m "feat(backend): add admin auth constants, token payload, session secret resolver"
```

---

### Task 4: Cookie helpers

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-auth.cookies.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-auth.cookies.spec.ts`

**Interfaces:**

- Produces: `readCookie(request, name): string | null`; `setAdminAuthCookies(res, access, refresh, secure)`; `clearAdminAuthCookies(res, secure)`; `setAdminSsoStateCookie(res, state, secure)`; `clearAdminSsoStateCookie(res, secure)`. SSO-state cookie path is `/admin/auth/sso`; access/refresh cookie path is `/`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin-auth/admin-auth.cookies.spec.ts`:

```typescript
import type { Response } from "express";
import {
  setAdminAuthCookies,
  clearAdminAuthCookies,
} from "./admin-auth.cookies.js";
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
} from "./admin-auth.constants.js";

function fakeResponse(): { res: Response; cookies: string[] } {
  let store: string | string[] | undefined;
  const res = {
    getHeader: () => store,
    setHeader: (_name: string, value: string | string[]) => {
      store = value;
    },
  } as unknown as Response;
  return {
    res,
    get cookies() {
      return Array.isArray(store) ? store : store ? [store] : [];
    },
  } as { res: Response; cookies: string[] };
}

describe("admin auth cookies", () => {
  it("sets HttpOnly Lax access + refresh cookies", () => {
    const ctx = fakeResponse();
    setAdminAuthCookies(ctx.res, "access-token", "refresh-token", true);
    const joined = ctx.cookies.join("\n");
    expect(joined).toContain(`${ADMIN_ACCESS_COOKIE}=access-token`);
    expect(joined).toContain(`${ADMIN_REFRESH_COOKIE}=refresh-token`);
    expect(joined).toContain("HttpOnly");
    expect(joined).toContain("SameSite=Lax");
    expect(joined).toContain("Secure");
  });

  it("clears cookies with Max-Age=0", () => {
    const ctx = fakeResponse();
    clearAdminAuthCookies(ctx.res, true);
    expect(ctx.cookies.join("\n")).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.cookies`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/backend/src/modules/admin-auth/admin-auth.cookies.ts` by translating the sibling cookies file (read at `/Users/akadlec/Development/Studio81Labs/tabletap/apps/backend/src/admin-auth/admin-auth.cookies.ts`) to Tarmoto naming: import the `ADMIN_*` constants from `./admin-auth.constants.js`, keep the `readCookie`/`setAdminAuthCookies`/`clearAdminAuthCookies`/`setAdminSsoStateCookie`/`clearAdminSsoStateCookie`/`appendCookie` functions verbatim except cookie names come from the Tarmoto constants and `ADMIN_SSO_COOKIE_PATH = '/admin/auth/sso'`. Access/refresh `maxAgeSeconds` use `ADMIN_ACCESS_TOKEN_SECONDS` / `ADMIN_REFRESH_TOKEN_SECONDS`.

Full implementation:

```typescript
import type { Request, Response } from "express";
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_ACCESS_TOKEN_SECONDS,
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_TOKEN_SECONDS,
  ADMIN_SSO_STATE_COOKIE,
} from "./admin-auth.constants.js";

interface CookieOptions {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setAdminAuthCookies(
  response: Response,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    maxAgeSeconds: ADMIN_ACCESS_TOKEN_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure,
  });
  appendCookie(response, ADMIN_REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    maxAgeSeconds: ADMIN_REFRESH_TOKEN_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure,
  });
}

export function clearAdminAuthCookies(
  response: Response,
  secure: boolean,
): void {
  for (const name of [ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE]) {
    appendCookie(response, name, "", {
      httpOnly: true,
      maxAgeSeconds: 0,
      path: "/",
      sameSite: "Lax",
      secure,
    });
  }
}

const ADMIN_SSO_COOKIE_PATH = "/admin/auth/sso";

export function setAdminSsoStateCookie(
  response: Response,
  state: string,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_SSO_STATE_COOKIE, state, {
    httpOnly: true,
    maxAgeSeconds: 10 * 60,
    path: ADMIN_SSO_COOKIE_PATH,
    sameSite: "Lax",
    secure,
  });
}

export function clearAdminSsoStateCookie(
  response: Response,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_SSO_STATE_COOKIE, "", {
    httpOnly: true,
    maxAgeSeconds: 0,
    path: ADMIN_SSO_COOKIE_PATH,
    sameSite: "Lax",
    secure,
  });
}

function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  pieces.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSeconds !== undefined) {
    pieces.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.httpOnly) pieces.push("HttpOnly");
  pieces.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.secure) pieces.push("Secure");

  const current = response.getHeader("Set-Cookie");
  const cookie = pieces.join("; ");
  if (Array.isArray(current)) {
    response.setHeader("Set-Cookie", [...current, cookie]);
  } else if (typeof current === "string") {
    response.setHeader("Set-Cookie", [current, cookie]);
  } else {
    response.setHeader("Set-Cookie", cookie);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.cookies`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-auth.cookies.ts apps/backend/src/modules/admin-auth/admin-auth.cookies.spec.ts
git commit -m "feat(backend): add admin auth cookie helpers"
```

---

### Task 5: Password + refresh-token hashing helpers

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-password.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-password.spec.ts`

**Interfaces:**

- Produces: `hashAdminPassword(plain: string): Promise<string>`; `verifyAdminPassword(plain: string, hash: string): Promise<boolean>`; `hashRefreshToken(token: string): string` (sha-256 hex, for the `token_hash` column); `generateRefreshToken(): string` (random 32-byte base64url).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin-auth/admin-password.spec.ts`:

```typescript
import {
  hashAdminPassword,
  verifyAdminPassword,
  hashRefreshToken,
  generateRefreshToken,
} from "./admin-password.js";

describe("admin password + token helpers", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashAdminPassword("correct horse");
    expect(hash).not.toBe("correct horse");
    expect(await verifyAdminPassword("correct horse", hash)).toBe(true);
    expect(await verifyAdminPassword("wrong", hash)).toBe(false);
  });

  it("hashes refresh tokens deterministically", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).not.toBe(hashRefreshToken("def"));
  });

  it("generates distinct opaque refresh tokens", () => {
    expect(generateRefreshToken()).not.toBe(generateRefreshToken());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-password`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/backend/src/modules/admin-auth/admin-password.ts`:

```typescript
import { createHash, randomBytes } from "node:crypto";
import * as bcrypt from "bcrypt";

const BCRYPT_ROUNDS = 12;

export function hashAdminPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyAdminPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-password`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-password.ts apps/backend/src/modules/admin-auth/admin-password.spec.ts
git commit -m "feat(backend): add admin password + refresh-token hashing helpers"
```

---

### Task 6: AdminAuthService (login, session create, refresh rotation, logout)

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-auth.service.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-auth.service.spec.ts`

**Interfaces:**

- Consumes: `JwtService`, `ConfigService`, repositories for `AdminUser`/`AdminSession`/`AdminRefreshToken`, helpers from Tasks 3 & 5.
- Produces:
  - `serializeAdminUser(user: AdminUser): AdminUserView` → `{ id, email, role, status }`.
  - `class AdminAuthService` with:
    - `loginWithPassword(email: string, password: string): Promise<AdminSessionTokens>`
    - `createSession(adminUserId: string): Promise<AdminSessionTokens>`
    - `refresh(refreshToken: string): Promise<AdminSessionTokens>`
    - `revoke(refreshToken: string): Promise<void>`
    - `findActiveById(id: string): Promise<AdminUser | null>`
    - `findOrProvisionSsoUser(provider: string, subject: string, email: string): Promise<AdminUser>`
  - `interface AdminSessionTokens { accessToken: string; refreshToken: string; user: AdminUserView; expiresIn: number }`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin-auth/admin-auth.service.spec.ts`:

```typescript
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { AdminAuthService } from "./admin-auth.service.js";
import { hashAdminPassword, hashRefreshToken } from "./admin-password.js";

function repoMock<T extends object>(overrides: Partial<T> = {}): T {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((v: unknown) => v),
    save: jest.fn((v: unknown) => v),
    update: jest.fn(),
    ...overrides,
  } as unknown as T;
}

const config = { get: () => "development" } as unknown as ConfigService;
const jwt = new JwtService({ secret: "test-secret" });

describe("AdminAuthService.loginWithPassword", () => {
  it("rejects unknown email", async () => {
    const users = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock() as never,
      repoMock() as never,
    );
    await expect(
      service.loginWithPassword("nobody@x.io", "pw"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("issues tokens for valid credentials", async () => {
    const passwordHash = await hashAdminPassword("hunter2");
    const adminUser = {
      id: "a1",
      email: "ops@tarmoto.app",
      role: "admin",
      status: "active",
      password_hash: passwordHash,
    };
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue(adminUser),
    });
    const sessions = repoMock({
      save: jest.fn().mockResolvedValue({ id: "sess1" }),
    });
    const refreshTokens = repoMock();
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      sessions as never,
      refreshTokens as never,
    );

    const result = await service.loginWithPassword(
      "ops@tarmoto.app",
      "hunter2",
    );
    expect(result.user).toEqual({
      id: "a1",
      email: "ops@tarmoto.app",
      role: "admin",
      status: "active",
    });
    expect(typeof result.accessToken).toBe("string");
    expect(refreshTokens.save).toHaveBeenCalled();
    const savedHash = (refreshTokens.save as jest.Mock).mock.calls[0][0]
      .token_hash;
    // Stored hash must be the SHA-256 of the opaque token, never the raw token.
    expect(savedHash).toBe(hashRefreshToken(result.refreshToken));
  });

  it("rejects a disabled account", async () => {
    const passwordHash = await hashAdminPassword("hunter2");
    const users = repoMock({
      findOne: jest.fn().mockResolvedValue({
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "disabled",
        password_hash: passwordHash,
      }),
    });
    const service = new AdminAuthService(
      jwt,
      config,
      users as never,
      repoMock() as never,
      repoMock() as never,
    );
    await expect(
      service.loginWithPassword("ops@tarmoto.app", "hunter2"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.service`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

Create `apps/backend/src/modules/admin-auth/admin-auth.service.ts`:

```typescript
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { LessThan, Repository } from "typeorm";
import { AdminUser, type AdminRole } from "../../entities/admin-user.entity.js";
import { AdminSession } from "../../entities/admin-session.entity.js";
import { AdminRefreshToken } from "../../entities/admin-refresh-token.entity.js";
import {
  ADMIN_ACCESS_TOKEN_SCOPE,
  ADMIN_ACCESS_TOKEN_SECONDS,
  ADMIN_REFRESH_TOKEN_SECONDS,
} from "./admin-auth.constants.js";
import { resolveAdminSessionSecret } from "./admin-session-secret.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  verifyAdminPassword,
} from "./admin-password.js";

export interface AdminUserView {
  id: string;
  email: string;
  role: AdminRole;
  status: "active" | "disabled";
}

export interface AdminSessionTokens {
  accessToken: string;
  refreshToken: string;
  user: AdminUserView;
  expiresIn: number;
}

export function serializeAdminUser(user: AdminUser): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
  };
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(AdminUser)
    private readonly users: Repository<AdminUser>,
    @InjectRepository(AdminSession)
    private readonly sessions: Repository<AdminSession>,
    @InjectRepository(AdminRefreshToken)
    private readonly refreshTokens: Repository<AdminRefreshToken>,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AdminSessionTokens> {
    const user = await this.users.findOne({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        password_hash: true,
      },
    });
    if (
      !user ||
      user.status !== "active" ||
      !user.password_hash ||
      !(await verifyAdminPassword(password, user.password_hash))
    ) {
      throw new UnauthorizedException("Invalid credentials");
    }
    await this.users.update({ id: user.id }, { last_login_at: new Date() });
    return this.createSession(user.id);
  }

  async createSession(adminUserId: string): Promise<AdminSessionTokens> {
    const user = await this.findActiveById(adminUserId);
    if (!user) throw new UnauthorizedException("Invalid admin");

    const now = Date.now();
    const session = await this.sessions.save(
      this.sessions.create({
        admin_user_id: user.id,
        expires_at: new Date(now + ADMIN_REFRESH_TOKEN_SECONDS * 1000),
        last_seen_at: new Date(now),
      }),
    );
    return this.issueTokens(user, session.id);
  }

  async refresh(rawRefreshToken: string): Promise<AdminSessionTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: tokenHash },
    });
    if (!stored || stored.revoked_at || stored.expires_at <= new Date()) {
      // Reuse of a rotated/expired token: revoke the whole session chain.
      if (stored?.session_id) {
        await this.revokeSession(stored.session_id);
      }
      throw new UnauthorizedException("Invalid refresh token");
    }

    const session = await this.sessions.findOne({
      where: { id: stored.session_id },
    });
    if (!session || session.revoked_at || session.expires_at <= new Date()) {
      throw new UnauthorizedException("Invalid session");
    }
    const user = await this.findActiveById(session.admin_user_id);
    if (!user) throw new UnauthorizedException("Invalid admin");

    // Rotate: mint a new refresh token, mark the old one replaced+revoked.
    const tokens = await this.issueTokens(user, session.id);
    await this.refreshTokens.update(
      { id: stored.id },
      {
        revoked_at: new Date(),
        last_used_at: new Date(),
        replaced_by_token_id: tokens.refreshTokenId,
      },
    );
    await this.sessions.update(
      { id: session.id },
      { last_seen_at: new Date() },
    );
    return tokens.tokens;
  }

  async revoke(rawRefreshToken: string): Promise<void> {
    const stored = await this.refreshTokens.findOne({
      where: { token_hash: hashRefreshToken(rawRefreshToken) },
    });
    if (stored) await this.revokeSession(stored.session_id);
  }

  async findActiveById(id: string): Promise<AdminUser | null> {
    const user = await this.users.findOne({ where: { id } });
    if (!user || user.status !== "active") return null;
    return user;
  }

  async findOrProvisionSsoUser(
    provider: string,
    subject: string,
    email: string,
  ): Promise<AdminUser> {
    const normalizedEmail = email.toLowerCase().trim();
    const bySso = await this.users.findOne({
      where: { sso_provider: provider, sso_subject: subject },
    });
    if (bySso) {
      if (bySso.status !== "active") {
        throw new UnauthorizedException("Admin account disabled");
      }
      return bySso;
    }
    // No open self-signup: only link SSO to a pre-seeded admin row by email.
    const byEmail = await this.users.findOne({
      where: { email: normalizedEmail },
    });
    if (!byEmail || byEmail.status !== "active") {
      throw new UnauthorizedException("No admin account for this identity");
    }
    await this.users.update(
      { id: byEmail.id },
      {
        sso_provider: provider,
        sso_subject: subject,
        last_login_at: new Date(),
      },
    );
    return byEmail;
  }

  private async issueTokens(
    user: AdminUser,
    sessionId: string,
  ): Promise<{
    tokens: AdminSessionTokens;
    refreshTokenId: string;
  }> {
    const secret = resolveAdminSessionSecret(this.config);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret, expiresIn: ADMIN_ACCESS_TOKEN_SECONDS },
    );
    const rawRefreshToken = generateRefreshToken();
    const saved = await this.refreshTokens.save(
      this.refreshTokens.create({
        session_id: sessionId,
        token_hash: hashRefreshToken(rawRefreshToken),
        expires_at: new Date(Date.now() + ADMIN_REFRESH_TOKEN_SECONDS * 1000),
      }),
    );
    return {
      refreshTokenId: saved.id,
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        user: serializeAdminUser(user),
        expiresIn: ADMIN_ACCESS_TOKEN_SECONDS,
      },
    };
  }

  private async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.sessions.update(
      { id: sessionId, revoked_at: undefined },
      { revoked_at: now },
    );
    await this.refreshTokens.update(
      { session_id: sessionId, revoked_at: undefined },
      { revoked_at: now },
    );
  }
}
```

> Note: `LessThan` is imported for future cleanup queries; if your linter flags it as unused remove the import. Keep the file focused on the behavior under test.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-auth.service.ts apps/backend/src/modules/admin-auth/admin-auth.service.spec.ts
git commit -m "feat(backend): add admin auth service with refresh-token rotation"
```

---

### Task 7: InternalGuard (authenticate `/admin/*` + enforce role rank)

**Files:**

- Create: `apps/backend/src/modules/admin/internal.guard.ts`
- Test: `apps/backend/src/modules/admin/internal.guard.spec.ts`

**Interfaces:**

- Consumes: `JwtService`, `ConfigService`, `Reflector`, `AdminSession`/`AdminRefreshToken` repos via the service is NOT used here — guard reads sessions directly via an injected `Repository<AdminSession>` (+ `AdminUser` relation through `admin_user_id`).
- Produces: `class InternalGuard implements CanActivate`. Sets `request.adminUser`. Public-bypass paths: `POST /admin/auth/login`, `POST /admin/auth/refresh`, `POST /admin/auth/logout`, `GET /admin/auth/sso/github/start`, `GET /admin/auth/sso/github/callback`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin/internal.guard.spec.ts`:

```typescript
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { InternalGuard } from "./internal.guard.js";
import { ADMIN_ACCESS_TOKEN_SCOPE } from "../admin-auth/admin-auth.constants.js";

const config = { get: () => "development" } as unknown as ConfigService;
const jwt = new JwtService({
  secret: "dev-only-admin-secret-do-not-use-in-production",
});

function contextFor(
  method: string,
  url: string,
  cookieToken?: string,
  requiredRoles?: string[],
): ExecutionContext {
  const req: Record<string, unknown> = {
    method,
    url,
    originalUrl: url,
    headers: cookieToken
      ? { cookie: `tarmoto_admin_access=${cookieToken}` }
      : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
    __req: req,
  } as unknown as ExecutionContext;
}

function guardWith(opts: {
  session?: unknown;
  requiredRoles?: string[];
}): InternalGuard {
  const reflector = {
    getAllAndOverride: () => opts.requiredRoles,
  } as unknown as Reflector;
  const sessions = {
    findOne: jest.fn().mockResolvedValue(opts.session ?? null),
    update: jest.fn(),
  };
  const audit = { record: jest.fn() };
  return new InternalGuard(
    jwt,
    config,
    reflector,
    sessions as never,
    audit as never,
  );
}

describe("InternalGuard", () => {
  it("bypasses public auth paths", async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor("POST", "/admin/auth/login")),
    ).resolves.toBe(true);
  });

  it("rejects missing token on a protected admin path", async () => {
    const guard = guardWith({});
    await expect(
      guard.canActivate(contextFor("GET", "/admin/metrics")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("allows a valid session and sets adminUser", async () => {
    const token = await jwt.signAsync(
      { sub: "a1", sid: "s1", scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: "dev-only-admin-secret-do-not-use-in-production" },
    );
    const guard = guardWith({
      session: {
        id: "s1",
        admin_user_id: "a1",
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: "a1", role: "support", status: "active" },
      },
    });
    const ctx = contextFor("GET", "/admin/metrics", token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      (ctx as unknown as { __req: { adminUser?: unknown } }).__req.adminUser,
    ).toBeDefined();
  });

  it("forbids when role rank is insufficient", async () => {
    const token = await jwt.signAsync(
      { sub: "a1", sid: "s1", scope: ADMIN_ACCESS_TOKEN_SCOPE },
      { secret: "dev-only-admin-secret-do-not-use-in-production" },
    );
    const guard = guardWith({
      requiredRoles: ["admin"],
      session: {
        id: "s1",
        admin_user_id: "a1",
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
        admin_user: { id: "a1", role: "support", status: "active" },
      },
    });
    await expect(
      guard.canActivate(contextFor("GET", "/admin/admins", token, ["admin"])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=internal.guard`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the guard**

Create `apps/backend/src/modules/admin/internal.guard.ts`. Model on the sibling guard (`/Users/akadlec/Development/Studio81Labs/tabletap/apps/backend/src/internal/internal.guard.ts`) but: (a) TypeORM repository for `AdminSession` joined to `AdminUser` via a manual second query, (b) route path from `request.originalUrl ?? request.url` split on `?`, (c) only the admin-path branch (no internal x-token branch — Tarmoto has no internal-token API), (d) delegate audit denials to an injected `AdminAuditService.record(...)` (Task 8).

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { Request } from "express";
import { AdminSession } from "../../entities/admin-session.entity.js";
import { AdminUser, type AdminRole } from "../../entities/admin-user.entity.js";
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_ACCESS_TOKEN_SCOPE,
} from "../admin-auth/admin-auth.constants.js";
import type { AdminAccessTokenPayload } from "../admin-auth/admin-access-token-payload.js";
import { ADMIN_ROLES_KEY } from "../admin-auth/admin-role.decorator.js";
import { hasRequiredAdminRole } from "../admin-auth/admin-role-rank.js";
import { resolveAdminSessionSecret } from "../admin-auth/admin-session-secret.js";
import { readCookie } from "../admin-auth/admin-auth.cookies.js";
import { AdminAuditService } from "./admin-audit.interceptor.js";

export interface AdminRequest extends Request {
  adminUser?: AdminUser;
}

const PUBLIC_ADMIN_AUTH_PATHS = new Set([
  "POST /admin/auth/login",
  "POST /admin/auth/refresh",
  "POST /admin/auth/logout",
  "GET /admin/auth/sso/github/start",
  "GET /admin/auth/sso/github/callback",
]);

@Injectable()
export class InternalGuard implements CanActivate {
  private readonly logger = new Logger("InternalGuard");

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @InjectRepository(AdminSession)
    private readonly sessions: Repository<AdminSession>,
    private readonly audit: AdminAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (this.isPublicAdminAuthPath(request)) return true;

    await this.authenticate(request);
    this.assertRole(context, request);
    return true;
  }

  private async authenticate(request: AdminRequest): Promise<void> {
    const token = this.readAccessToken(request);
    if (!token) {
      this.deny(request, "missing_session");
      throw new UnauthorizedException("Admin session required");
    }
    let payload: AdminAccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminAccessTokenPayload>(token, {
        secret: resolveAdminSessionSecret(this.config),
      });
    } catch {
      this.deny(request, "invalid_session");
      throw new UnauthorizedException("Admin session required");
    }
    if (payload.scope !== ADMIN_ACCESS_TOKEN_SCOPE || !payload.sid) {
      this.deny(request, "invalid_session");
      throw new UnauthorizedException("Admin session required");
    }

    const now = new Date();
    const session = await this.sessions.findOne({
      where: { id: payload.sid, admin_user_id: payload.sub },
      relations: { admin_user: true } as never,
    });
    const adminUser = await this.loadSessionUser(session, payload.sub);
    if (
      !session ||
      session.revoked_at ||
      session.expires_at <= now ||
      !adminUser ||
      adminUser.status !== "active"
    ) {
      this.deny(request, "invalid_session");
      throw new UnauthorizedException("Admin session required");
    }
    request.adminUser = adminUser;
    await this.sessions.update({ id: session.id }, { last_seen_at: now });
  }

  // AdminSession has no ORM relation to AdminUser (kept as a plain FK column),
  // so resolve the user explicitly.
  private async loadSessionUser(
    session: AdminSession | null,
    adminUserId: string,
  ): Promise<AdminUser | null> {
    if (!session) return null;
    return this.sessions.manager.findOne(AdminUser, {
      where: { id: adminUserId },
    });
  }

  private assertRole(context: ExecutionContext, request: AdminRequest): void {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) return;
    const role = request.adminUser?.role;
    if (role && hasRequiredAdminRole(role, requiredRoles)) return;
    this.deny(request, "insufficient_role");
    throw new ForbiddenException("Admin role not allowed");
  }

  private readAccessToken(request: AdminRequest): string | null {
    const cookie = readCookie(request, ADMIN_ACCESS_COOKIE);
    if (cookie) return cookie;
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
    return null;
  }

  private deny(request: AdminRequest, reason: string): void {
    this.logger.warn(
      JSON.stringify({
        event: "admin.auth.denied",
        reason,
        path: this.path(request),
      }),
    );
    void this.audit.record({
      event_key: "admin.auth.denied",
      outcome: "denied",
      method: request.method ?? "UNKNOWN",
      path: this.path(request),
      admin_user_id: request.adminUser?.id ?? null,
      admin_role: request.adminUser?.role ?? null,
      metadata: { reason },
    });
  }

  private path(request: AdminRequest): string {
    return (request.originalUrl ?? request.url ?? "").split("?")[0];
  }

  private isPublicAdminAuthPath(request: AdminRequest): boolean {
    const key = `${request.method ?? "GET"} ${this.path(request)}`;
    return PUBLIC_ADMIN_AUTH_PATHS.has(key);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=internal.guard`
Expected: PASS (4 tests). (The guard's `relations` hint is ignored by the mock; the test stubs `sessions.findOne` and `sessions.manager` is not exercised because the mock returns the session with an inlined `admin_user` — adjust the test's `loadSessionUser` path by having the mock's `manager.findOne` return the user. If the test needs it, set `sessions.manager = { findOne: () => session.admin_user }` in `guardWith`.)

> Implementation note for the worker: in `guardWith`, set
> `sessions.manager = { findOne: jest.fn().mockResolvedValue(opts.session?.admin_user ?? null) }`
> so `loadSessionUser` resolves the stubbed user. Add that line before constructing the guard.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin/internal.guard.ts apps/backend/src/modules/admin/internal.guard.spec.ts
git commit -m "feat(backend): add admin InternalGuard with session + role-rank enforcement"
```

---

### Task 8: AdminAuditService + interceptor

**Files:**

- Create: `apps/backend/src/modules/admin/admin-audit.interceptor.ts` (exports both `AdminAuditService` and `AdminAuditInterceptor`), `apps/backend/src/modules/admin/admin-audit-context.ts`
- Test: `apps/backend/src/modules/admin/admin-audit.interceptor.spec.ts`

**Interfaces:**

- Produces: `class AdminAuditService { record(entry: AdminAuditEntry): Promise<void> }` (best-effort insert into `admin_audit_logs`, never throws); `interface AdminAuditEntry`; `class AdminAuditInterceptor implements NestInterceptor` (records `outcome:'allowed'` for mutating `/admin/*` requests using `request.adminUser`); `setAdminAuditTarget(request, { target_type, target_id })` helper to annotate the audited target.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin/admin-audit.interceptor.spec.ts`:

```typescript
import { AdminAuditService } from "./admin-audit.interceptor.js";

function repoMock() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe("AdminAuditService.record", () => {
  it("persists an audit row", async () => {
    const repo = repoMock();
    const service = new AdminAuditService(repo as never);
    await service.record({
      event_key: "admin.metrics.read",
      outcome: "allowed",
      method: "GET",
      path: "/admin/metrics",
      admin_user_id: "a1",
      admin_role: "admin",
      metadata: null,
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it("never throws when the insert fails", async () => {
    const repo = repoMock();
    repo.save = jest.fn().mockRejectedValue(new Error("db down"));
    const service = new AdminAuditService(repo as never);
    await expect(
      service.record({
        event_key: "admin.auth.denied",
        outcome: "denied",
        method: "GET",
        path: "/admin/metrics",
        admin_user_id: null,
        admin_role: null,
        metadata: { reason: "missing_session" },
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-audit.interceptor`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/backend/src/modules/admin/admin-audit-context.ts`:

```typescript
import type { Request } from "express";

export interface AdminAuditTarget {
  target_type: string;
  target_id: string;
}

const KEY = "__adminAuditTarget";

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
```

Create `apps/backend/src/modules/admin/admin-audit.interceptor.ts`:

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { tap } from "rxjs";
import type { Observable } from "rxjs";
import { AdminAuditLog } from "../../entities/admin-audit-log.entity.js";
import type { AdminRole } from "../../entities/admin-user.entity.js";
import type { AdminRequest } from "./internal.guard.js";
import { getAdminAuditTarget } from "./admin-audit-context.js";

export interface AdminAuditEntry {
  event_key: string;
  outcome: "allowed" | "denied";
  method: string;
  path: string;
  admin_user_id: string | null;
  admin_role: AdminRole | null;
  target_type?: string | null;
  target_id?: string | null;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger("AdminAuditService");

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async record(entry: AdminAuditEntry): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          event_key: entry.event_key,
          outcome: entry.outcome,
          method: entry.method,
          path: entry.path,
          admin_user_id: entry.admin_user_id,
          admin_role: entry.admin_role,
          target_type: entry.target_type ?? null,
          target_id: entry.target_id ?? null,
          metadata: entry.metadata,
        }),
      );
    } catch (err) {
      // Best-effort: auditing must never break the request it observes.
      this.logger.error(
        `audit persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const method = request.method ?? "GET";
    const path = (request.originalUrl ?? request.url ?? "").split("?")[0];

    return next.handle().pipe(
      tap(() => {
        if (!MUTATING.has(method)) return;
        const target = getAdminAuditTarget(request);
        void this.audit.record({
          event_key: `admin.${method.toLowerCase()}`,
          outcome: "allowed",
          method,
          path,
          admin_user_id: request.adminUser?.id ?? null,
          admin_role: request.adminUser?.role ?? null,
          target_type: target?.target_type ?? null,
          target_id: target?.target_id ?? null,
          metadata: null,
        });
      }),
    );
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-audit.interceptor`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin/admin-audit.interceptor.ts apps/backend/src/modules/admin/admin-audit-context.ts apps/backend/src/modules/admin/admin-audit.interceptor.spec.ts
git commit -m "feat(backend): add admin audit service + interceptor"
```

---

### Task 9: AdminAuthController + GitHub SSO + DTOs

**Files:**

- Create: `apps/backend/src/modules/admin-auth/dto/admin-auth.dto.ts`, `admin-auth.controller.ts`, `admin-github-sso.ts`
- Test: `apps/backend/src/modules/admin-auth/admin-auth.controller.spec.ts`

**Interfaces:**

- Consumes: `AdminAuthService`, cookie helpers, `ConfigService`.
- Produces: `@Controller('admin/auth')` with `POST login`, `POST refresh`, `GET me`, `POST logout`, `GET sso/github/start`, `GET sso/github/callback`. DTOs: `AdminLoginDto { email, password }`, `AdminAuthSessionResponseDto { user, expiresIn }`, `AdminMeResponseDto { user }`.
- Produces: `admin-github-sso.ts` → `buildGithubAuthorizeUrl(state, config)`, `exchangeGithubCode(code, config): Promise<{ subject: string; email: string }>`.

- [ ] **Step 1: Write the failing controller test**

Create `apps/backend/src/modules/admin-auth/admin-auth.controller.spec.ts`:

```typescript
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { ADMIN_REFRESH_COOKIE } from "./admin-auth.constants.js";

function mockResponse(): Response {
  return {
    getHeader: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn(),
  } as unknown as Response;
}

describe("AdminAuthController", () => {
  let controller: AdminAuthController;
  const service = {
    loginWithPassword: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn(),
    findActiveById: jest.fn(),
  } as unknown as jest.Mocked<AdminAuthService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: service },
        { provide: ConfigService, useValue: { get: () => "development" } },
      ],
    }).compile();
    controller = moduleRef.get(AdminAuthController);
    jest.clearAllMocks();
  });

  it("logs in and sets cookies", async () => {
    (service.loginWithPassword as jest.Mock).mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      user: {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
      },
      expiresIn: 540,
    });
    const res = mockResponse();
    const body = await controller.login(
      { email: "ops@tarmoto.app", password: "pw" },
      res,
    );
    expect(service.loginWithPassword).toHaveBeenCalledWith(
      "ops@tarmoto.app",
      "pw",
    );
    expect(res.setHeader).toHaveBeenCalled();
    expect(body).toEqual({
      user: {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
      },
      expiresIn: 540,
    });
  });

  it("returns the current admin from the request", () => {
    const req = {
      adminUser: {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
      },
    } as unknown as Request;
    expect(controller.me(req)).toEqual({
      user: {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
      },
    });
  });

  it("logout reads the refresh cookie and clears cookies", async () => {
    const req = {
      headers: { cookie: `${ADMIN_REFRESH_COOKIE}=r` },
    } as unknown as Request;
    const res = mockResponse();
    await controller.logout(req, res);
    expect(service.revoke).toHaveBeenCalledWith("r");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement DTOs**

Create `apps/backend/src/modules/admin-auth/dto/admin-auth.dto.ts`:

```typescript
import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";
import type { AdminUserView } from "../admin-auth.service.js";

export class AdminLoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}

export class AdminUserViewDto implements AdminUserView {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ["read_only", "support", "admin", "super_admin"] })
  role!: AdminUserView["role"];
  @ApiProperty({ enum: ["active", "disabled"] })
  status!: AdminUserView["status"];
}

export class AdminAuthSessionResponseDto {
  @ApiProperty({ type: AdminUserViewDto }) user!: AdminUserViewDto;
  @ApiProperty() expiresIn!: number;
}

export class AdminMeResponseDto {
  @ApiProperty({ type: AdminUserViewDto }) user!: AdminUserViewDto;
}
```

- [ ] **Step 4: Implement the GitHub SSO helper**

Create `apps/backend/src/modules/admin-auth/admin-github-sso.ts`:

```typescript
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";

export function buildGithubAuthorizeUrl(
  state: string,
  config: ConfigService,
): string {
  const clientId = config.get<string>("TARMOTO_ADMIN_GITHUB_CLIENT_ID");
  if (!clientId) throw new UnauthorizedException("GitHub SSO not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "read:user user:email",
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGithubCode(
  code: string,
  config: ConfigService,
): Promise<{ subject: string; email: string }> {
  const clientId = config.get<string>("TARMOTO_ADMIN_GITHUB_CLIENT_ID");
  const clientSecret = config.get<string>("TARMOTO_ADMIN_GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new UnauthorizedException("GitHub SSO not configured");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new UnauthorizedException("GitHub token exchange failed");
  }

  const headers = {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tarmoto-admin",
  };
  const userRes = await fetch("https://api.github.com/user", { headers });
  const user = (await userRes.json()) as { id?: number; email?: string };
  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers,
  });
  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;
  const primary =
    emails.find((e) => e.primary && e.verified)?.email ?? user.email;
  if (!user.id || !primary) {
    throw new UnauthorizedException("GitHub profile missing id/email");
  }
  return { subject: String(user.id), email: primary };
}
```

- [ ] **Step 5: Implement the controller**

Create `apps/backend/src/modules/admin-auth/admin-auth.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { AdminAuthService, serializeAdminUser } from "./admin-auth.service.js";
import {
  AdminAuthSessionResponseDto,
  AdminLoginDto,
  AdminMeResponseDto,
} from "./dto/admin-auth.dto.js";
import {
  ADMIN_REFRESH_COOKIE,
  ADMIN_SSO_STATE_COOKIE,
} from "./admin-auth.constants.js";
import {
  clearAdminAuthCookies,
  clearAdminSsoStateCookie,
  readCookie,
  setAdminAuthCookies,
  setAdminSsoStateCookie,
} from "./admin-auth.cookies.js";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
} from "./admin-github-sso.js";
import type { AdminRequest } from "../admin/internal.guard.js";

const SSO_ERROR_REDIRECT = "/?adminAuthError=sso";

@ApiTags("admin-auth")
@Controller("admin/auth")
export class AdminAuthController {
  constructor(
    private readonly service: AdminAuthService,
    private readonly config: ConfigService,
  ) {}

  private get secure(): boolean {
    return this.config.get<string>("NODE_ENV") === "production";
  }

  @Post("login")
  @ApiOperation({ summary: "Admin password login (dev / fallback)" })
  @ApiResponse({ status: 201, type: AdminAuthSessionResponseDto })
  async login(
    @Body() dto: AdminLoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminAuthSessionResponseDto> {
    const tokens = await this.service.loginWithPassword(
      dto.email,
      dto.password,
    );
    setAdminAuthCookies(
      res,
      tokens.accessToken,
      tokens.refreshToken,
      this.secure,
    );
    return { user: tokens.user, expiresIn: tokens.expiresIn };
  }

  @Post("refresh")
  @ApiOperation({ summary: "Rotate the admin session tokens" })
  @ApiResponse({ status: 201, type: AdminAuthSessionResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminAuthSessionResponseDto> {
    const raw = readCookie(req, ADMIN_REFRESH_COOKIE);
    if (!raw) throw new UnauthorizedException("Missing refresh token");
    const tokens = await this.service.refresh(raw);
    setAdminAuthCookies(
      res,
      tokens.accessToken,
      tokens.refreshToken,
      this.secure,
    );
    return { user: tokens.user, expiresIn: tokens.expiresIn };
  }

  @Get("me")
  @ApiOperation({ summary: "Current admin session" })
  @ApiResponse({ status: 200, type: AdminMeResponseDto })
  me(@Req() req: Request): AdminMeResponseDto {
    const adminUser = (req as AdminRequest).adminUser;
    if (!adminUser) throw new UnauthorizedException();
    return { user: serializeAdminUser(adminUser) };
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke the admin session" })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw = readCookie(req, ADMIN_REFRESH_COOKIE);
    if (raw) await this.service.revoke(raw);
    clearAdminAuthCookies(res, this.secure);
  }

  @Get("sso/github/start")
  @ApiOperation({ summary: "Begin GitHub OAuth" })
  start(@Res() res: Response): void {
    const state = randomBytes(16).toString("hex");
    setAdminSsoStateCookie(res, state, this.secure);
    res.redirect(buildGithubAuthorizeUrl(state, this.config));
  }

  @Get("sso/github/callback")
  @ApiOperation({ summary: "GitHub OAuth callback" })
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const expectedState = readCookie(req, ADMIN_SSO_STATE_COOKIE);
      clearAdminSsoStateCookie(res, this.secure);
      if (!code || !state || !expectedState || state !== expectedState) {
        res.redirect(SSO_ERROR_REDIRECT);
        return;
      }
      const { subject, email } = await exchangeGithubCode(code, this.config);
      const user = await this.service.findOrProvisionSsoUser(
        "github",
        subject,
        email,
      );
      const tokens = await this.service.createSession(user.id);
      setAdminAuthCookies(
        res,
        tokens.accessToken,
        tokens.refreshToken,
        this.secure,
      );
      res.redirect("/");
    } catch {
      res.redirect(SSO_ERROR_REDIRECT);
    }
  }
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-auth.controller`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-auth/dto apps/backend/src/modules/admin-auth/admin-auth.controller.ts apps/backend/src/modules/admin-auth/admin-github-sso.ts apps/backend/src/modules/admin-auth/admin-auth.controller.spec.ts
git commit -m "feat(backend): add admin auth controller with GitHub SSO + cookie sessions"
```

---

### Task 10: Admin metrics endpoint (Overview data)

**Files:**

- Create: `apps/backend/src/modules/admin/dto/admin-metrics.dto.ts`, `admin-metrics.service.ts`, `admin-metrics.controller.ts`
- Test: `apps/backend/src/modules/admin/admin-metrics.controller.spec.ts`

**Interfaces:**

- Produces: `@Controller('admin')` `GET metrics` → `AdminMetricsDto { users: number; activeRides: number; featureFlags: number; pendingClosures: number }`. No `@AdminRoles` (any authenticated admin can read).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/modules/admin/admin-metrics.controller.spec.ts`:

```typescript
import { AdminMetricsController } from "./admin-metrics.controller.js";
import { AdminMetricsService } from "./admin-metrics.service.js";

describe("AdminMetricsController", () => {
  it("returns the metrics snapshot from the service", async () => {
    const snapshot = {
      users: 42,
      activeRides: 3,
      featureFlags: 0,
      pendingClosures: 5,
    };
    const service = {
      snapshot: jest.fn().mockResolvedValue(snapshot),
    } as unknown as AdminMetricsService;
    const controller = new AdminMetricsController(service);
    await expect(controller.metrics()).resolves.toEqual(snapshot);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-metrics.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement DTO + service + controller**

Create `apps/backend/src/modules/admin/dto/admin-metrics.dto.ts`:

```typescript
import { ApiProperty } from "@nestjs/swagger";

export class AdminMetricsDto {
  @ApiProperty() users!: number;
  @ApiProperty() activeRides!: number;
  @ApiProperty() featureFlags!: number;
  @ApiProperty() pendingClosures!: number;
}
```

Create `apps/backend/src/modules/admin/admin-metrics.service.ts`:

```typescript
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";
import { User } from "../../entities/user.entity.js";
import { RoadClosure } from "../../entities/road-closure.entity.js";
import type { AdminMetricsDto } from "./dto/admin-metrics.dto.js";

@Injectable()
export class AdminMetricsService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RoadClosure)
    private readonly closures: Repository<RoadClosure>,
  ) {}

  async snapshot(): Promise<AdminMetricsDto> {
    const [users, pendingClosures] = await Promise.all([
      this.users.count({ where: { deleted_at: IsNull() } }),
      this.closures.count(),
    ]);
    return {
      users,
      activeRides: 0, // wired to the rides module in a later phase
      featureFlags: 0, // wired when the flag store lands (Phase 3)
      pendingClosures,
    };
  }
}
```

Create `apps/backend/src/modules/admin/admin-metrics.controller.ts`:

```typescript
import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminMetricsService } from "./admin-metrics.service.js";
import { AdminMetricsDto } from "./dto/admin-metrics.dto.js";

@ApiTags("admin")
@Controller("admin")
export class AdminMetricsController {
  constructor(private readonly service: AdminMetricsService) {}

  @Get("metrics")
  @ApiOperation({ summary: "Admin overview metrics" })
  @ApiResponse({ status: 200, type: AdminMetricsDto })
  metrics(): Promise<AdminMetricsDto> {
    return this.service.snapshot();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPattern=admin-metrics.controller`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/admin/dto/admin-metrics.dto.ts apps/backend/src/modules/admin/admin-metrics.service.ts apps/backend/src/modules/admin/admin-metrics.controller.ts apps/backend/src/modules/admin/admin-metrics.controller.spec.ts
git commit -m "feat(backend): add admin overview metrics endpoint"
```

---

### Task 11: Wire admin modules into the app + apply guard/interceptor

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-auth.module.ts`, `apps/backend/src/modules/admin/admin.module.ts`
- Modify: `apps/backend/src/app.module.ts` (import both modules; register `InternalGuard` + `AdminAuditInterceptor` scoped to admin routes)
- Test: `apps/backend/test/admin-auth.e2e-spec.ts` (e2e through the Nest app)

**Interfaces:**

- Produces: `AdminAuthModule` (exports `AdminAuthService`), `AdminModule` (provides `InternalGuard`, `AdminAuditService`, `AdminAuditInterceptor`, metrics).

- [ ] **Step 1: Implement AdminAuthModule**

Create `apps/backend/src/modules/admin-auth/admin-auth.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminUser } from "../../entities/admin-user.entity.js";
import { AdminSession } from "../../entities/admin-session.entity.js";
import { AdminRefreshToken } from "../../entities/admin-refresh-token.entity.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminAuthController } from "./admin-auth.controller.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([AdminUser, AdminSession, AdminRefreshToken]),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
```

- [ ] **Step 2: Implement AdminModule**

Create `apps/backend/src/modules/admin/admin.module.ts`. It binds `InternalGuard` as an `APP_GUARD` and `AdminAuditInterceptor` as an `APP_INTERCEPTOR`. Both short-circuit for non-`/admin/*` paths (the guard returns `true` immediately when the path doesn't start with `/admin/`; add that early-return to `InternalGuard.canActivate` — update Task 7's guard with a leading `if (!this.path(request).startsWith('/admin/')) return true;`). The interceptor already no-ops for non-mutating/any path by only recording on mutating requests; add an early `if (!path.startsWith('/admin/')) return next.handle();`.

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AdminUser } from "../../entities/admin-user.entity.js";
import { AdminSession } from "../../entities/admin-session.entity.js";
import { AdminAuditLog } from "../../entities/admin-audit-log.entity.js";
import { User } from "../../entities/user.entity.js";
import { RoadClosure } from "../../entities/road-closure.entity.js";
import { InternalGuard } from "./internal.guard.js";
import {
  AdminAuditInterceptor,
  AdminAuditService,
} from "./admin-audit.interceptor.js";
import { AdminMetricsController } from "./admin-metrics.controller.js";
import { AdminMetricsService } from "./admin-metrics.service.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminUser,
      AdminSession,
      AdminAuditLog,
      User,
      RoadClosure,
    ]),
  ],
  controllers: [AdminMetricsController],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
```

Add the two early-returns described above to `internal.guard.ts` and `admin-audit.interceptor.ts`, then re-run their specs (`internal.guard`, `admin-audit.interceptor`) to confirm still green. Add a guard spec case: `await expect(guard.canActivate(contextFor('GET', '/rides'))).resolves.toBe(true);`.

- [ ] **Step 3: Register modules in AppModule**

In `apps/backend/src/app.module.ts`, add `AdminAuthModule` and `AdminModule` to the `imports` array (follow the existing import grouping/ordering).

- [ ] **Step 4: Write the e2e test**

Create `apps/backend/test/admin-auth.e2e-spec.ts` modeled on the existing backend e2e setup (check `apps/backend/test/` for the bootstrap pattern — reuse the same `Test.createTestingModule({ imports: [AppModule] })` + `app.init()` flow and the test DB). Assert:

```typescript
// pseudo-structure — mirror the existing e2e bootstrap in apps/backend/test
it("GET /admin/metrics without a session returns 401", async () => {
  await request(app.getHttpServer()).get("/admin/metrics").expect(401);
});

it("POST /admin/auth/login then GET /admin/metrics with the cookie returns 200", async () => {
  // seed an admin_user with a known password hash in beforeAll
  const login = await request(app.getHttpServer())
    .post("/admin/auth/login")
    .send({ email: "e2e-admin@tarmoto.app", password: "e2e-password" })
    .expect(201);
  const cookie = login.headers["set-cookie"];
  await request(app.getHttpServer())
    .get("/admin/metrics")
    .set("Cookie", cookie)
    .expect(200);
});
```

- [ ] **Step 5: Run e2e**

Run: `pnpm --filter @tarmoto/backend test:e2e -- --testPathPattern=admin-auth`
Expected: PASS (2 tests). If the repo has no e2e harness/test DB wired, downgrade this to an integration test using `Test.createTestingModule` + an in-memory sqlite or the docker Postgres, and note the deviation in the commit body.

- [ ] **Step 6: Run the full backend suite + build**

Run: `pnpm --filter @tarmoto/backend test && pnpm backend:build`
Expected: all green, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-auth.module.ts apps/backend/src/modules/admin/admin.module.ts apps/backend/src/modules/admin/internal.guard.ts apps/backend/src/modules/admin/admin-audit.interceptor.ts apps/backend/src/app.module.ts apps/backend/test/admin-auth.e2e-spec.ts apps/backend/src/modules/admin/internal.guard.spec.ts
git commit -m "feat(backend): wire admin auth + admin modules with global admin guard"
```

---

### Task 12: Seed a super_admin + regenerate OpenAPI

**Files:**

- Modify: the demo seeder under `apps/backend/src/scripts/` (the `DemoSeeder` referenced by `seed:demo`) to upsert one `super_admin`.
- Modify: regenerated `packages/openapi/openapi.yaml` and `packages/openapi-client/src/generated/schema.d.ts` (build artifacts).
- Test: extend the seeder smoke path (manual run).

- [ ] **Step 1: Add admin seeding**

In the seeder (`apps/backend/src/scripts/seed-demo-data.ts` / its `DemoSeeder`), add a step that upserts an `admin_users` row:

```typescript
// inside DemoSeeder.run(), after demo users
const adminRepo = this.dataSource.getRepository(AdminUser);
const email = "admin@tarmoto.app";
const existing = await adminRepo.findOne({ where: { email } });
if (!existing) {
  await adminRepo.save(
    adminRepo.create({
      email,
      password_hash: await hashAdminPassword("admin@tarmoto.app"),
      role: "super_admin",
      status: "active",
    }),
  );
  console.log("Seeded super_admin:", email);
}
```

Import `AdminUser` from `../entities/admin-user.entity.js` and `hashAdminPassword` from `../modules/admin-auth/admin-password.js` (adjust relative paths to the seeder's location).

- [ ] **Step 2: Run the seed**

Run: `pnpm db:up && pnpm db:seed`
Expected: log line `Seeded super_admin: admin@tarmoto.app`; re-running does not duplicate.

- [ ] **Step 3: Regenerate the OpenAPI spec + client**

Run: `pnpm openapi:gen`
Expected: `packages/openapi/openapi.yaml` now contains the `admin-auth` and `admin` tags / `/admin/...` paths; `packages/openapi-client/src/generated/schema.d.ts` regenerates with the new paths. Build the client if it has a build step: `pnpm --filter @tarmoto/openapi-client build` (skip if none).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/scripts packages/openapi/openapi.yaml packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): seed super_admin and regenerate admin OpenAPI contract"
```

---

## Admin SPA Tasks

### Task 13: Scaffold the `apps/admin` Vite app + root scripts

**Files:**

- Create: `apps/admin/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `wrangler.jsonc`, `src/main.tsx`, `src/styles.css`, `src/globals.d.ts`, `src/test/setup.ts`, `src/app/App.tsx` (placeholder)
- Modify: root `package.json` (scripts)

**Interfaces:**

- Produces: a runnable Vite app on port 3004; `pnpm --filter @tarmoto/admin test` runs Vitest.

- [ ] **Step 1: Create package.json**

Create `apps/admin/package.json` (model on `apps/poc-sensor/package.json` + sibling admin deps):

```json
{
  "name": "@tarmoto/admin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Tarmoto internal admin console",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "lint": "eslint .",
    "worker:deploy": "pnpm build && pnpm dlx wrangler@latest deploy"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.100.1",
    "@tarmoto/openapi-client": "workspace:*",
    "openapi-fetch": "^0.17.0",
    "openapi-react-query": "^0.5.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.7.0",
    "vite": "^8.0.10",
    "vitest": "^3.0.0"
  }
}
```

> Pin `@tarmoto/openapi-client`'s actual exported entry. Confirm its `package.json` `exports`/`types` so `import type { paths } from '@tarmoto/openapi-client'` resolves; if it only exports the schema under a subpath, import from there.

- [ ] **Step 2: Create tsconfig, vite config, index.html, entry**

Create `apps/admin/tsconfig.json` (model on `apps/poc-sensor/tsconfig.json`, add `"types": ["vitest/globals", "@testing-library/jest-dom"]` and `"jsx": "react-jsx"`).

Create `apps/admin/vite.config.ts`:

```typescript
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3004,
    // Proxy /admin/* to the backend so cookies are first-party in dev.
    proxy: {
      "/admin": "http://localhost:3000",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Create `apps/admin/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tarmoto Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/admin/src/test/setup.ts`:

```typescript
import "@testing-library/jest-dom/vitest";
```

Create `apps/admin/src/globals.d.ts`:

```typescript
interface Window {
  __TARMOTO_ADMIN_CONFIG__?: {
    passwordLoginEnabled: boolean;
  };
}
```

Create `apps/admin/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./data/queryClient.js";
import { App } from "./app/App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

Create `apps/admin/src/styles.css` with a minimal dark theme using CSS custom properties (background `#0d1117`, surface `#161b22`, text `#e6edf3`, accent `#f5a623`). Keep it short; screens add their own classes.

Create a placeholder `apps/admin/src/app/App.tsx` exporting `export function App() { return <div>Tarmoto Admin</div>; }` (replaced in Task 18).

- [ ] **Step 3: Create wrangler.jsonc**

Create `apps/admin/wrangler.jsonc` modeled on `apps/companion/wrangler.jsonc` for a static SPA served from `dist/` (assets binding). Keep the `/admin/*` API on the backend origin; the Worker serves the SPA and (in prod) proxies `/admin/*` to the backend so cookies stay first-party — document the prod proxy as a follow-up if the companion's worker handles routing differently.

- [ ] **Step 4: Add root scripts**

In the root `package.json` scripts, add:

```json
"admin:dev": "pnpm --filter @tarmoto/admin dev",
"admin:build": "pnpm --filter @tarmoto/admin build",
"admin:test": "pnpm --filter @tarmoto/admin test"
```

- [ ] **Step 5: Install + verify dev boots**

Run: `pnpm install`
Run: `pnpm --filter @tarmoto/admin test` → Expected: passes (no tests yet).
Run: `pnpm admin:dev` → Expected: Vite serves on `http://localhost:3004` showing "Tarmoto Admin". Stop it.

- [ ] **Step 6: Commit**

```bash
git add apps/admin package.json pnpm-lock.yaml
git commit -m "feat(cross): scaffold apps/admin Vite SPA shell"
```

---

### Task 14: Typed API client with refresh-on-401

**Files:**

- Create: `apps/admin/src/data/apiClient.ts`, `apps/admin/src/data/queryClient.ts`
- Test: `apps/admin/src/data/apiClient.test.ts`

**Interfaces:**

- Produces: `adminFetchWithRefresh(input, init): Promise<Response>` — on a 401 (except auth paths), POSTs `/admin/auth/refresh` once (deduplicated), replays on success, dispatches `tarmoto-admin-auth-expired` and returns the 401 on failure. `apiClient` (openapi-fetch, `baseUrl: ''`, `fetch: adminFetchWithRefresh`, `credentials: 'include'`). `$api` (openapi-react-query). `queryClient` (TanStack `QueryClient`).
- Produces event name constant `ADMIN_AUTH_EXPIRED_EVENT = 'tarmoto-admin-auth-expired'`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/data/apiClient.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adminFetchWithRefresh,
  ADMIN_AUTH_EXPIRED_EVENT,
} from "./apiClient.js";

describe("adminFetchWithRefresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes through a successful response", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);
    const res = await adminFetchWithRefresh("/admin/metrics", {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on 401 then replays the original request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 })) // original
      .mockResolvedValueOnce(new Response("", { status: 201 })) // refresh
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // replay
    vi.stubGlobal("fetch", fetchMock);
    const res = await adminFetchWithRefresh("/admin/metrics", {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/admin/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("dispatches the expiry event when refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 })); // refresh fails
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn();
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    const res = await adminFetchWithRefresh("/admin/metrics", {});
    window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handler);
    expect(res.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not try to refresh the refresh endpoint itself", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminFetchWithRefresh("/admin/auth/refresh", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/admin test -- apiClient`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/admin/src/data/apiClient.ts`:

```typescript
import createClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import type { paths } from "@tarmoto/openapi-client";

export const ADMIN_AUTH_EXPIRED_EVENT = "tarmoto-admin-auth-expired";

const NO_REFRESH_PATHS = [
  "/admin/auth/login",
  "/admin/auth/refresh",
  "/admin/auth/logout",
];

let inflightRefresh: Promise<boolean> | null = null;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

async function refreshOnce(): Promise<boolean> {
  if (!inflightRefresh) {
    inflightRefresh = fetch("/admin/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}

export async function adminFetchWithRefresh(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  const withCreds: RequestInit = { ...init, credentials: "include" };
  const response = await fetch(input, withCreds);

  if (
    response.status !== 401 ||
    NO_REFRESH_PATHS.some((p) => url.startsWith(p))
  ) {
    return response;
  }

  const refreshed = await refreshOnce();
  if (!refreshed) {
    window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    return response;
  }
  return fetch(input, withCreds);
}

export const apiClient = createClient<paths>({
  baseUrl: "",
  fetch: adminFetchWithRefresh,
});

export const $api = createQueryClient(apiClient);
```

Create `apps/admin/src/data/queryClient.ts`:

```typescript
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/admin test -- apiClient`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/data
git commit -m "feat(cross): add admin SPA api client with refresh-on-401"
```

---

### Task 15: adminAuthApi + useAdminAuth hook

**Files:**

- Create: `apps/admin/src/auth/adminAuthApi.ts`, `apps/admin/src/auth/useAdminAuth.ts`
- Test: `apps/admin/src/auth/useAdminAuth.test.tsx`

**Interfaces:**

- Produces: `adminAuthApi` → `getCurrentAdmin(): Promise<AdminUserView | null>`, `loginWithPassword(email, password): Promise<AdminUserView>`, `logout(): Promise<void>`, `startGithubSso(): void`.
- Produces: `useAdminAuth()` → `{ status: 'loading' | 'authenticated' | 'unauthenticated', user: AdminUserView | null, error: string | null, loginWithPassword, logout }`. Subscribes to `ADMIN_AUTH_EXPIRED_EVENT`.
- Produces: `type AdminUserView = { id: string; email: string; role: AdminRole; status: 'active' | 'disabled' }` (re-exported from the generated schema types).

- [ ] **Step 1: Write the failing hook test**

Create `apps/admin/src/auth/useAdminAuth.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAdminAuth } from "./useAdminAuth.js";
import { adminAuthApi } from "./adminAuthApi.js";
import { ADMIN_AUTH_EXPIRED_EVENT } from "../data/apiClient.js";

vi.mock("./adminAuthApi.js", () => ({
  adminAuthApi: {
    getCurrentAdmin: vi.fn(),
    loginWithPassword: vi.fn(),
    logout: vi.fn(),
    startGithubSso: vi.fn(),
  },
}));

const admin = {
  id: "a1",
  email: "ops@tarmoto.app",
  role: "admin" as const,
  status: "active" as const,
};

describe("useAdminAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves to authenticated when a session exists", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(admin);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("authenticated"));
    expect(result.current.user).toEqual(admin);
  });

  it("resolves to unauthenticated when there is no session", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  });

  it("drops to unauthenticated on the expiry event", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(admin);
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.status).toBe("authenticated"));
    act(() => {
      window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/admin test -- useAdminAuth`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement adminAuthApi**

Create `apps/admin/src/auth/adminAuthApi.ts`:

```typescript
import { apiClient } from "../data/apiClient.js";

export type AdminRole = "read_only" | "support" | "admin" | "super_admin";
export interface AdminUserView {
  id: string;
  email: string;
  role: AdminRole;
  status: "active" | "disabled";
}

export const adminAuthApi = {
  async getCurrentAdmin(): Promise<AdminUserView | null> {
    const { data, error } = await apiClient.GET("/admin/auth/me");
    if (error || !data) return null;
    return data.user as AdminUserView;
  },

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AdminUserView> {
    const { data, error } = await apiClient.POST("/admin/auth/login", {
      body: { email, password },
    });
    if (error || !data) throw new Error("Invalid credentials");
    return data.user as AdminUserView;
  },

  async logout(): Promise<void> {
    await apiClient.POST("/admin/auth/logout", {});
  },

  startGithubSso(): void {
    window.location.href = "/admin/auth/sso/github/start";
  },
};
```

> If the generated `paths` type names the `me`/`login` response shapes differently, adjust the `data.user` access to match. The `as AdminUserView` casts keep the hook decoupled from generated-type churn.

- [ ] **Step 4: Implement useAdminAuth**

Create `apps/admin/src/auth/useAdminAuth.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { adminAuthApi, type AdminUserView } from "./adminAuthApi.js";
import { ADMIN_AUTH_EXPIRED_EVENT } from "../data/apiClient.js";

type Status = "loading" | "authenticated" | "unauthenticated";

export interface AdminAuthState {
  status: Status;
  user: AdminUserView | null;
  error: string | null;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAdminAuth(): AdminAuthState {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AdminUserView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    adminAuthApi
      .getCurrentAdmin()
      .then((found) => {
        if (!active) return;
        setUser(found);
        setStatus(found ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        if (!active) return;
        setStatus("unauthenticated");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setStatus("unauthenticated");
    };
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
    return () =>
      window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const loginWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const found = await adminAuthApi.loginWithPassword(email, password);
        setUser(found);
        setStatus("authenticated");
      } catch {
        setError("Invalid credentials");
        throw new Error("Invalid credentials");
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    await adminAuthApi.logout();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  return { status, user, error, loginWithPassword, logout };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @tarmoto/admin test -- useAdminAuth`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/auth
git commit -m "feat(cross): add admin auth api + useAdminAuth hook"
```

---

### Task 16: LoginScreen

**Files:**

- Create: `apps/admin/src/auth/LoginScreen.tsx`
- Test: `apps/admin/src/auth/LoginScreen.test.tsx`

**Interfaces:**

- Consumes: `useAdminAuth` state (passed as props: `onPasswordLogin(email, password)`, `onGithubSso()`, `error`).
- Produces: `LoginScreen({ onPasswordLogin, onGithubSso, error, passwordLoginEnabled })`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/auth/LoginScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginScreen } from "./LoginScreen.js";

describe("LoginScreen", () => {
  it("renders the GitHub SSO button and triggers it", async () => {
    const onGithubSso = vi.fn();
    render(
      <LoginScreen
        onPasswordLogin={vi.fn()}
        onGithubSso={onGithubSso}
        error={null}
        passwordLoginEnabled={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /github/i }));
    expect(onGithubSso).toHaveBeenCalledTimes(1);
  });

  it("submits the password form when enabled", async () => {
    const onPasswordLogin = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginScreen
        onPasswordLogin={onPasswordLogin}
        onGithubSso={vi.fn()}
        error={null}
        passwordLoginEnabled
      />,
    );
    await userEvent.type(screen.getByLabelText(/email/i), "ops@tarmoto.app");
    await userEvent.type(screen.getByLabelText(/password/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(onPasswordLogin).toHaveBeenCalledWith("ops@tarmoto.app", "pw");
  });

  it("shows an error message", () => {
    render(
      <LoginScreen
        onPasswordLogin={vi.fn()}
        onGithubSso={vi.fn()}
        error="Invalid credentials"
        passwordLoginEnabled
      />,
    );
    expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/admin test -- LoginScreen`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/admin/src/auth/LoginScreen.tsx`:

```tsx
import { useState, type FormEvent } from "react";

interface LoginScreenProps {
  onPasswordLogin: (email: string, password: string) => Promise<void>;
  onGithubSso: () => void;
  error: string | null;
  passwordLoginEnabled: boolean;
}

export function LoginScreen({
  onPasswordLogin,
  onGithubSso,
  error,
  passwordLoginEnabled,
}: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void onPasswordLogin(email, password).catch(() => {
      /* error surfaced via the error prop */
    });
  };

  return (
    <main className="login">
      <h1>Tarmoto Admin</h1>
      {error ? <p className="login__error">{error}</p> : null}
      <button type="button" className="login__sso" onClick={onGithubSso}>
        Continue with GitHub
      </button>
      {passwordLoginEnabled ? (
        <form className="login__form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit">Sign in</button>
        </form>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/admin test -- LoginScreen`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/auth/LoginScreen.tsx apps/admin/src/auth/LoginScreen.test.tsx
git commit -m "feat(cross): add admin LoginScreen"
```

---

### Task 17: App shell (Sidebar + TopBar) + auth gate + routing

**Files:**

- Create: `apps/admin/src/app/routes.ts`, `apps/admin/src/components/layout/Sidebar.tsx`, `apps/admin/src/components/layout/TopBar.tsx`
- Modify: `apps/admin/src/app/App.tsx`
- Test: `apps/admin/src/app/App.test.tsx`

**Interfaces:**

- Produces: `routes` (`[{ key: 'overview', label: 'Overview' }, { key: 'users', label: 'Users' }, { key: 'feature-flags', label: 'Feature Flags' }, { key: 'content', label: 'Content' }]`), `useHashRoute()` → `{ active, navigate }`. `App` shows `LoginScreen` when unauthenticated, else `Sidebar` + `TopBar` + active screen (only Overview wired in this phase; others render a "Coming soon" stub).

- [ ] **Step 1: Write the failing App test**

Create `apps/admin/src/app/App.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { App } from "./App.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";

vi.mock("../auth/adminAuthApi.js", () => ({
  adminAuthApi: {
    getCurrentAdmin: vi.fn(),
    loginWithPassword: vi.fn(),
    logout: vi.fn(),
    startGithubSso: vi.fn(),
  },
}));

vi.mock("../data/useAdminMetrics.js", () => ({
  useAdminMetrics: () => ({
    data: { users: 0, activeRides: 0, featureFlags: 0, pendingClosures: 0 },
    isPending: false,
    error: null,
  }),
}));

function renderApp() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("shows the login screen when unauthenticated", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /github/i }),
      ).toBeInTheDocument(),
    );
  });

  it("shows the shell + Overview when authenticated", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "a1",
      email: "ops@tarmoto.app",
      role: "admin",
      status: "active",
    });
    renderApp();
    await waitFor(() =>
      expect(screen.getByText("Overview")).toBeInTheDocument(),
    );
    expect(screen.getByText("ops@tarmoto.app")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/admin test -- App`
Expected: FAIL (current placeholder App renders neither).

- [ ] **Step 3: Implement routes + hash hook**

Create `apps/admin/src/app/routes.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";

export interface AdminRoute {
  key: string;
  label: string;
}

export const routes: AdminRoute[] = [
  { key: "overview", label: "Overview" },
  { key: "users", label: "Users" },
  { key: "feature-flags", label: "Feature Flags" },
  { key: "content", label: "Content" },
];

function currentKey(): string {
  const key = window.location.hash.replace(/^#\/?/, "");
  return routes.some((r) => r.key === key) ? key : "overview";
}

export function useHashRoute() {
  const [active, setActive] = useState(currentKey());
  useEffect(() => {
    const onChange = () => setActive(currentKey());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((key: string) => {
    window.location.hash = `#/${key}`;
  }, []);
  return { active, navigate };
}
```

- [ ] **Step 4: Implement Sidebar + TopBar**

Create `apps/admin/src/components/layout/Sidebar.tsx`:

```tsx
import { routes } from "../../app/routes.js";

interface SidebarProps {
  active: string;
  onNavigate: (key: string) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Admin sections">
      <div className="sidebar__brand">Tarmoto Admin</div>
      <ul>
        {routes.map((route) => (
          <li key={route.key}>
            <button
              type="button"
              className={active === route.key ? "is-active" : ""}
              aria-current={active === route.key ? "page" : undefined}
              onClick={() => onNavigate(route.key)}
            >
              {route.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

Create `apps/admin/src/components/layout/TopBar.tsx`:

```tsx
interface TopBarProps {
  email: string;
  role: string;
  onLogout: () => void;
}

export function TopBar({ email, role, onLogout }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__spacer" />
      <div className="topbar__user">
        <span className="topbar__email">{email}</span>
        <span className="topbar__role">{role}</span>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Implement App**

Replace `apps/admin/src/app/App.tsx`:

```tsx
import { useAdminAuth } from "../auth/useAdminAuth.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";
import { LoginScreen } from "../auth/LoginScreen.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { TopBar } from "../components/layout/TopBar.js";
import { OverviewScreen } from "../screens/OverviewScreen.js";
import { useHashRoute } from "./routes.js";

function passwordLoginEnabled(): boolean {
  return (
    window.__TARMOTO_ADMIN_CONFIG__?.passwordLoginEnabled ?? import.meta.env.DEV
  );
}

export function App() {
  const auth = useAdminAuth();
  const { active, navigate } = useHashRoute();

  if (auth.status === "loading") {
    return <div className="app-loading">Loading…</div>;
  }

  if (auth.status === "unauthenticated" || !auth.user) {
    return (
      <LoginScreen
        onPasswordLogin={auth.loginWithPassword}
        onGithubSso={adminAuthApi.startGithubSso}
        error={auth.error}
        passwordLoginEnabled={passwordLoginEnabled()}
      />
    );
  }

  return (
    <div className="layout">
      <Sidebar active={active} onNavigate={navigate} />
      <div className="layout__main">
        <TopBar
          email={auth.user.email}
          role={auth.user.role}
          onLogout={auth.logout}
        />
        <main className="layout__content">
          {active === "overview" ? (
            <OverviewScreen />
          ) : (
            <section>
              <h2>{active}</h2>
              <p>Coming soon.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @tarmoto/admin test -- App`
Expected: PASS (2 tests). (Depends on `OverviewScreen` + `useAdminMetrics` from Task 18; if running tasks in order, implement Task 18 first or stub `OverviewScreen` to render `<h2>Overview</h2>` then flesh it out. The App test mocks `useAdminMetrics`, so a minimal OverviewScreen suffices here.)

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/app apps/admin/src/components
git commit -m "feat(cross): add admin app shell, sidebar, topbar, auth gate"
```

---

### Task 18: Overview screen + useAdminMetrics

**Files:**

- Create: `apps/admin/src/data/useAdminMetrics.ts`, `apps/admin/src/screens/OverviewScreen.tsx`
- Test: `apps/admin/src/screens/OverviewScreen.test.tsx`

**Interfaces:**

- Produces: `useAdminMetrics()` → `$api.useQuery('get', '/admin/metrics')` returning `{ data, isPending, error }`. `OverviewScreen` renders four metric cards (Users, Active rides, Feature flags, Pending closures).

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/screens/OverviewScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewScreen } from "./OverviewScreen.js";

vi.mock("../data/useAdminMetrics.js", () => ({
  useAdminMetrics: () => ({
    data: { users: 128, activeRides: 4, featureFlags: 0, pendingClosures: 7 },
    isPending: false,
    error: null,
  }),
}));

describe("OverviewScreen", () => {
  it("renders the metric values", () => {
    render(<OverviewScreen />);
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Pending closures")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tarmoto/admin test -- OverviewScreen`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/admin/src/data/useAdminMetrics.ts`:

```typescript
import { $api } from "./apiClient.js";

export function useAdminMetrics() {
  return $api.useQuery("get", "/admin/metrics");
}
```

> If the generated client's query key tuple differs (e.g. requires an options arg), match the signature used elsewhere; the shape is `$api.useQuery('get', '/admin/metrics')`.

Create `apps/admin/src/screens/OverviewScreen.tsx`:

```tsx
import { useAdminMetrics } from "../data/useAdminMetrics.js";

interface MetricCardProps {
  label: string;
  value: number | string;
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="metric-card">
      <span className="metric-card__value">{value}</span>
      <span className="metric-card__label">{label}</span>
    </div>
  );
}

export function OverviewScreen() {
  const { data, isPending, error } = useAdminMetrics();

  return (
    <section>
      <h2>Overview</h2>
      {error ? <p className="error">Failed to load metrics.</p> : null}
      <div className="metric-grid">
        <MetricCard
          label="Users"
          value={isPending ? "—" : (data?.users ?? 0)}
        />
        <MetricCard
          label="Active rides"
          value={isPending ? "—" : (data?.activeRides ?? 0)}
        />
        <MetricCard
          label="Feature flags"
          value={isPending ? "—" : (data?.featureFlags ?? 0)}
        />
        <MetricCard
          label="Pending closures"
          value={isPending ? "—" : (data?.pendingClosures ?? 0)}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @tarmoto/admin test -- OverviewScreen`
Expected: PASS (1 test).

- [ ] **Step 5: Run the whole admin suite + typecheck + build**

Run: `pnpm --filter @tarmoto/admin test && pnpm --filter @tarmoto/admin typecheck && pnpm --filter @tarmoto/admin build`
Expected: all green.

- [ ] **Step 6: Manual smoke (end-to-end)**

Run backend (`pnpm db:up && pnpm db:seed && pnpm backend:dev`) and admin (`pnpm admin:dev`). In the browser at `http://localhost:3004`: with `passwordLoginEnabled` true in dev, log in as `admin@tarmoto.app` / `admin@tarmoto.app`; confirm the Overview cards populate (Users > 0, Pending closures reflects seed). Log out returns to the login screen. Document the result.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminMetrics.ts apps/admin/src/screens
git commit -m "feat(cross): add admin Overview screen with live metrics"
```

---

## Self-Review

**Spec coverage** (against `2026-06-26-admin-console-design.md` §4–§7, Phase 1):

- Separate `admin_users` identity + sessions + refresh rotation + audit log → Tasks 1, 6, 8. ✓
- Role rank + `@AdminRoles` + `InternalGuard` → Tasks 2, 7, 11. ✓
- GitHub SSO + dev password login + cookie JWT access/refresh → Tasks 3, 4, 5, 9. ✓
- `AdminAuditInterceptor` writing mutating actions → Task 8, wired Task 11. ✓
- Vite + React SPA shell, `adminFetchWithRefresh` (incl. `/admin/auth/me` NOT excluded from refresh), `useAdminAuth`, `LoginScreen`, Sidebar/TopBar → Tasks 13–17. ✓
- Overview surface + metrics endpoint → Tasks 10, 18. ✓
- Seed a `super_admin`; regenerate OpenAPI client → Task 12. ✓
- New Cloudflare Worker deploy target, dev port 3004, root scripts → Task 13. ✓
- TARMOTO\_ env (`TARMOTO_ADMIN_SESSION_SECRET`, `TARMOTO_ADMIN_GITHUB_CLIENT_ID/SECRET`) → Tasks 3, 9. ✓
- Dual entity/migration registration (memory note) → Task 1 Step 7. ✓

**Out of Phase-1 scope (correctly deferred to later plans):** user management surface, feature-flag store/evaluation/CRUD + public read contract, geo-content moderation, command palette. Overview's `activeRides`/`featureFlags` are stubbed to `0` with a comment pointing at the phase that wires them — no hidden fallback, value is explicit.

**Placeholder scan:** No "TBD"/"implement later". Two tasks delegate verbatim translation to a named sibling source file (cookies Task 4 gives the full code anyway; guard Task 7 gives full code). The e2e harness (Task 11 Step 4) is described structurally because it must match the repo's existing e2e bootstrap, which the implementer reads in `apps/backend/test/` — acceptable, with a documented fallback.

**Type consistency:** `AdminUserView` (`{id,email,role,status}`) is identical across `serializeAdminUser` (Task 6), the controller DTOs (Task 9), and the SPA (`adminAuthApi`, Task 15). `ADMIN_AUTH_EXPIRED_EVENT` defined in Task 14, consumed in Tasks 14/15. `AdminAccessTokenPayload` (`sub`/`sid`/`scope`) defined Task 3, used in Tasks 6 (sign) and 7 (verify). Cookie names from the shared constants (Task 3) used everywhere. `useAdminMetrics` return shape (`data/isPending/error`) consistent across Tasks 17 (mock), 18.
