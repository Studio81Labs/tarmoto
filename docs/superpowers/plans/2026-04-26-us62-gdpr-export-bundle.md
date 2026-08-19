# US-62 GDPR Data Export Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GDPR Article 15 self-service data export. The user clicks "Export my data" in the companion settings; the backend assembles a ZIP containing every personal record we hold and delivers it via a signed, time-limited download URL.

**Architecture:** A new `account/data-export` feature module owns the request lifecycle. The HTTP endpoint enqueues a `data_export_request` row (status=`queued`) and returns 202 immediately. An in-process worker (a `Promise.then` chain — placeholder for the future BullMQ infra in #276) assembles the ZIP via `archiver`, writes it to a local-filesystem store (placeholder for #277 object storage), generates an HMAC-signed download URL valid for 7 days, and updates the row to `ready`. A second endpoint (`GET /account/data-export/:id`) returns status + signed URL. A third (`GET /account/data-export/:id/download`) verifies the HMAC + expiry and streams the file. Email delivery is deferred to #262; until then the URL is surfaced via the GET endpoint, which the companion polls.

**Tech Stack:** NestJS 11 controller/service, TypeORM 0.3 entity + migration, `archiver` for ZIP streaming, Node `crypto.createHmac` for URL signing, Node `fs/promises` for local storage. Tests use Jest + `@nestjs/testing` mocks (existing pattern in `rides.controller.spec.ts`).

**Scope notes / decisions:**

- **In-process "background" worker** — `archiver` runs after `res.status(202).send()` returns. This is honest async execution, not a queue, but the seam is clean: when #276 lands, swap the worker call for a `queue.add('data-export', { requestId })`. The plan does NOT pull in BullMQ.
- **Local filesystem storage** — files land in `process.env.TARMOTO_EXPORT_STORAGE_DIR` (default `/tmp/tarmoto-exports`). When #277 lands, swap the `LocalExportStorage` for an S3 client behind the same `ExportStorage` interface.
- **Signed URLs** — HMAC-SHA256 over `${requestId}:${expiresAt}` using `process.env.TARMOTO_EXPORT_SIGNING_SECRET`. Included as `?sig=...&exp=...` query params. The download endpoint re-computes and constant-time-compares.
- **Email** — skipped. The acceptance criteria allow surfacing the URL via the GET endpoint as a fallback for users without email; we use that path for everyone until #262 lands. README.txt inside the ZIP notes the 7-day expiry instead of an email.
- **Missing entities** — `Bike`, `NotificationSettings`, `PrivacySettings` have no DB tables yet. Emit empty arrays and call them out in `README.txt` so the export still validates the GDPR contract; the assembler can be extended in-place when those entities land.
- **Anonymized road quality contributions** — explicitly excluded per acceptance criteria.
- **Photos** — review `photos` is a `text[]` of URLs in the existing entity. We include the URLs in `reviews.json` but do not download the binary files (the photo storage backend isn't built yet — see #265, #277). README.txt notes this.
- **Rate limit** — application-level: if the user already has a row with status `queued|processing|ready`, return 200 with that row instead of 202 with a new one. Cleared once the row is `expired` or `failed`.

---

## File structure

**Create (backend):**

- `apps/backend/src/entities/data-export-request.entity.ts` — TypeORM entity
- `apps/backend/src/migrations/1715500000000-AddDataExportRequests.ts` — migration
- `apps/backend/src/modules/account/data-export/data-export.controller.ts` — 3 endpoints (POST, GET status, GET download)
- `apps/backend/src/modules/account/data-export/data-export.service.ts` — request creation, idempotency check, signed-URL helpers
- `apps/backend/src/modules/account/data-export/data-export.processor.ts` — assembles ZIP, writes to storage, marks row ready
- `apps/backend/src/modules/account/data-export/data-export.module.ts` — wires controller + service + processor + storage
- `apps/backend/src/modules/account/data-export/storage/export-storage.interface.ts` — abstraction with `write(stream) → key`, `read(key) → stream`, `exists(key)`
- `apps/backend/src/modules/account/data-export/storage/local-export-storage.ts` — fs implementation
- `apps/backend/src/modules/account/data-export/storage/local-export-storage.spec.ts`
- `apps/backend/src/modules/account/data-export/signed-url.ts` — pure HMAC sign + verify helpers
- `apps/backend/src/modules/account/data-export/signed-url.spec.ts`
- `apps/backend/src/modules/account/data-export/assembler/bundle-assembler.ts` — orchestrates entity-to-file emission, writes to a stream
- `apps/backend/src/modules/account/data-export/assembler/bundle-assembler.spec.ts`
- `apps/backend/src/modules/account/data-export/assembler/sanitizers.ts` — strips password*hash, stripe*\*, etc.
- `apps/backend/src/modules/account/data-export/assembler/sanitizers.spec.ts`
- `apps/backend/src/modules/account/data-export/assembler/gpx.ts` — re-uses pattern from `rides.service.exportAllGpx` for per-trip / per-ride GPX
- `apps/backend/src/modules/account/data-export/dto/data-export-request.dto.ts` — response DTO
- `apps/backend/src/modules/account/data-export/data-export.controller.spec.ts`
- `apps/backend/src/modules/account/data-export/data-export.service.spec.ts`
- `apps/backend/src/modules/account/data-export/data-export.processor.spec.ts`

**Modify (backend):**

- `apps/backend/src/modules/account/account.module.ts` — import `DataExportModule`
- `apps/backend/src/modules/account/index.ts` — re-export
- `apps/backend/src/data-source.ts` — register the new entity (verify if already glob-loaded)
- `apps/backend/package.json` — add `archiver` + `@types/archiver`

**Modify (companion):**

- `apps/companion/src/lib/api.ts` — change `exportData` to POST `/account/data-export` and return typed `DataExportRequest`; add `getDataExport(id)` for polling
- `apps/companion/src/app/(dashboard)/settings/data/page.tsx` — handle 202, persist requestId in component state, poll until status=`ready`, surface download link

**Regenerate:**

- `packages/openapi/openapi.yaml` + `types.ts` (via `pnpm --filter @tarmoto/openapi generate`)

---

## Task 1: Add `archiver` dependency

**Files:**

- Modify: `apps/backend/package.json`

- [ ] **Step 1: Install dependency**

Run from repo root:

```bash
pnpm --filter @tarmoto/backend add archiver
pnpm --filter @tarmoto/backend add -D @types/archiver
```

- [ ] **Step 2: Verify**

Run:

```bash
pnpm --filter @tarmoto/backend exec node -e "console.log(require('archiver/package.json').version)"
```

Expected: prints a version like `7.x.x`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml
git commit -m "chore(backend): add archiver dep for gdpr export"
```

---

## Task 2: `DataExportRequest` entity + migration

**Files:**

- Create: `apps/backend/src/entities/data-export-request.entity.ts`
- Create: `apps/backend/src/migrations/1715500000000-AddDataExportRequests.ts`

- [ ] **Step 1: Write the entity**

```typescript
// apps/backend/src/entities/data-export-request.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "./user.entity.js";

export type DataExportStatus =
  "queued" | "processing" | "ready" | "failed" | "expired";

@Entity("data_export_requests")
export class DataExportRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  @Index("idx_data_export_requests_user")
  user_id!: string;

  @Column({ type: "varchar", length: 20, default: "queued" })
  status!: DataExportStatus;

  @Column({ type: "varchar", length: 500, nullable: true })
  storage_key!: string | null;

  @Column({ type: "bigint", nullable: true })
  byte_size!: string | null;

  @Column({ type: "timestamptz" })
  expires_at!: Date;

  @Column({ type: "timestamptz", nullable: true })
  completed_at!: Date | null;

  @Column({ type: "text", nullable: true })
  error_message!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;
}
```

- [ ] **Step 2: Write the migration**

```typescript
// apps/backend/src/migrations/1715500000000-AddDataExportRequests.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDataExportRequests1715500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "data_export_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'queued',
        "storage_key" varchar(500),
        "byte_size" bigint,
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz,
        "error_message" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_data_export_requests" PRIMARY KEY ("id"),
        CONSTRAINT "fk_data_export_requests_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_data_export_requests_user" ON "data_export_requests" ("user_id");`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_data_export_requests_user_status" ON "data_export_requests" ("user_id", "status");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_data_export_requests_user_status";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_data_export_requests_user";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "data_export_requests";`);
  }
}
```

- [ ] **Step 3: Verify entity is loaded**

Open `apps/backend/src/data-source.ts`. Entities and migrations are loaded by glob (`src/entities/*.entity.ts` and `src/migrations/*.ts`). If they are listed individually, add `DataExportRequest` and the new migration. Otherwise no change needed.

Run:

```bash
grep -n "entities\|migrations" apps/backend/src/data-source.ts
```

- [ ] **Step 4: Run migration**

```bash
pnpm db:up
pnpm db:migrate
```

Expected: migration `1715500000000-AddDataExportRequests` runs without error.

- [ ] **Step 5: Verify table**

```bash
docker exec -i $(docker ps --filter name=postgres -q | head -1) psql -U postgres -d tarmoto -c "\d data_export_requests"
```

Expected: table description with all columns and indexes.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/data-export-request.entity.ts \
        apps/backend/src/migrations/1715500000000-AddDataExportRequests.ts \
        apps/backend/src/data-source.ts
git commit -m "feat(backend): add data_export_requests table"
```

---

## Task 3: Signed URL helpers (TDD)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/signed-url.ts`
- Create: `apps/backend/src/modules/account/data-export/signed-url.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// signed-url.spec.ts
import { signDownloadUrl, verifyDownloadSignature } from "./signed-url.js";

describe("signed-url", () => {
  const secret = "test-secret-please-change";

  it("verifies a freshly signed token", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: "req-1",
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: "req-1",
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe("valid");
  });

  it("rejects a tampered request id", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: "req-1",
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: "req-2",
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe("invalid");
  });

  it("rejects an expired token", () => {
    const expiresAt = Date.now() - 1;
    const sig = signDownloadUrl({
      requestId: "req-1",
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: "req-1",
        expiresAt,
        signature: sig,
        secret,
      }),
    ).toBe("expired");
  });

  it("rejects a wrong secret", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId: "req-1",
      expiresAt,
      secret,
    });
    expect(
      verifyDownloadSignature({
        requestId: "req-1",
        expiresAt,
        signature: sig,
        secret: "wrong",
      }),
    ).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @tarmoto/backend test -- signed-url
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// signed-url.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignArgs = {
  requestId: string;
  expiresAt: number;
  secret: string;
};

export type VerifyArgs = SignArgs & { signature: string };

export type VerifyResult = "valid" | "invalid" | "expired";

export function signDownloadUrl({
  requestId,
  expiresAt,
  secret,
}: SignArgs): string {
  const payload = `${requestId}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyDownloadSignature({
  requestId,
  expiresAt,
  signature,
  secret,
}: VerifyArgs): VerifyResult {
  if (Date.now() > expiresAt) return "expired";
  const expected = signDownloadUrl({ requestId, expiresAt, secret });
  if (expected.length !== signature.length) return "invalid";
  const ok = timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature, "utf8"),
  );
  return ok ? "valid" : "invalid";
}
```

- [ ] **Step 4: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- signed-url
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/account/data-export/signed-url.ts \
        apps/backend/src/modules/account/data-export/signed-url.spec.ts
git commit -m "feat(backend): hmac signed-url helpers for data export"
```

---

## Task 4: `ExportStorage` interface + local fs implementation (TDD)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/storage/export-storage.interface.ts`
- Create: `apps/backend/src/modules/account/data-export/storage/local-export-storage.ts`
- Create: `apps/backend/src/modules/account/data-export/storage/local-export-storage.spec.ts`

- [ ] **Step 1: Write the interface**

```typescript
// export-storage.interface.ts
import type { Readable } from "node:stream";

export const EXPORT_STORAGE = Symbol("EXPORT_STORAGE");

export interface ExportStorage {
  write(key: string, body: Readable): Promise<{ byteSize: number }>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// local-export-storage.spec.ts
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalExportStorage } from "./local-export-storage.js";

describe("LocalExportStorage", () => {
  let dir: string;
  let storage: LocalExportStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tarmoto-export-test-"));
    storage = new LocalExportStorage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a stream and returns its byte size", async () => {
    const body = Readable.from(Buffer.from("hello world"));
    const result = await storage.write("foo/bar.zip", body);
    expect(result.byteSize).toBe(11);
    expect(statSync(join(dir, "foo/bar.zip")).size).toBe(11);
  });

  it("reads back the same bytes", async () => {
    await storage.write("a.zip", Readable.from(Buffer.from("abc")));
    const reader = await storage.read("a.zip");
    const chunks: Buffer[] = [];
    for await (const c of reader) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("abc");
  });

  it("deletes a written file", async () => {
    await storage.write("a.zip", Readable.from(Buffer.from("abc")));
    await storage.delete("a.zip");
    await expect(storage.read("a.zip")).rejects.toThrow();
  });

  it("rejects keys that escape the base dir", async () => {
    await expect(
      storage.write("../escape.zip", Readable.from(Buffer.from("x"))),
    ).rejects.toThrow(/invalid storage key/i);
  });
});
```

- [ ] **Step 3: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- local-export-storage
```

Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
// local-export-storage.ts
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Injectable } from "@nestjs/common";
import type { ExportStorage } from "./export-storage.interface.js";

@Injectable()
export class LocalExportStorage implements ExportStorage {
  constructor(private readonly baseDir: string) {}

  private resolveKey(key: string): string {
    const target = resolve(this.baseDir, key);
    const base = resolve(this.baseDir) + sep;
    if (!target.startsWith(base)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return target;
  }

  async write(key: string, body: Readable): Promise<{ byteSize: number }> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(body, createWriteStream(target));
    const s = await stat(target);
    return { byteSize: s.size };
  }

  async read(key: string): Promise<Readable> {
    const target = this.resolveKey(key);
    await stat(target);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await unlink(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}
```

- [ ] **Step 5: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- local-export-storage
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/account/data-export/storage/
git commit -m "feat(backend): local-fs export storage adapter"
```

---

## Task 5: Sanitizers (TDD)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/assembler/sanitizers.ts`
- Create: `apps/backend/src/modules/account/data-export/assembler/sanitizers.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// sanitizers.spec.ts
import { sanitizeUserForExport } from "./sanitizers.js";
import type { User } from "../../../../entities/user.entity.js";

describe("sanitizeUserForExport", () => {
  const baseUser = {
    id: "u1",
    email: "rider@example.com",
    password_hash: "hash-secret",
    display_name: "Rider",
    phone: "+15555550000",
    avatar_url: null,
    bio: null,
    home_region: "NA",
    home_location: null,
    work_location: null,
    preferences: { theme: "dark" },
    stripe_customer_id: "cus_123",
    stripe_subscription_id: "sub_123",
    subscription_tier: "free",
    subscription_status: "canceled",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
  } as unknown as User;

  it("removes password_hash", () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty("password_hash");
  });

  it("removes stripe identifiers", () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out).not.toHaveProperty("stripe_customer_id");
    expect(out).not.toHaveProperty("stripe_subscription_id");
  });

  it("preserves profile fields", () => {
    const out = sanitizeUserForExport(baseUser);
    expect(out.email).toBe("rider@example.com");
    expect(out.display_name).toBe("Rider");
    expect(out.preferences).toEqual({ theme: "dark" });
  });
});
```

- [ ] **Step 2: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- sanitizers
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// sanitizers.ts
import type { User } from "../../../../entities/user.entity.js";

const STRIPPED_USER_FIELDS = [
  "password_hash",
  "stripe_customer_id",
  "stripe_subscription_id",
] as const;

export type SanitizedUser = Omit<
  User,
  (typeof STRIPPED_USER_FIELDS)[number] | "contacts"
>;

export function sanitizeUserForExport(user: User): SanitizedUser {
  const clone: Record<string, unknown> = { ...user };
  for (const f of STRIPPED_USER_FIELDS) delete clone[f];
  delete clone.contacts;
  return clone as SanitizedUser;
}
```

- [ ] **Step 4: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- sanitizers
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/account/data-export/assembler/sanitizers.ts \
        apps/backend/src/modules/account/data-export/assembler/sanitizers.spec.ts
git commit -m "feat(backend): user sanitizer for gdpr export"
```

---

## Task 6: GPX helper (extract from rides service)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/assembler/gpx.ts`
- Modify: `apps/backend/src/modules/account/data-export/assembler/gpx.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// gpx.spec.ts
import { rideToGpx, tripDayToGpx } from "./gpx.js";

describe("rideToGpx", () => {
  it("produces single-track gpx wrapped with metadata", () => {
    const xml = rideToGpx({
      name: "Morning loop",
      startedAt: new Date("2026-04-01T08:00:00Z"),
      route: {
        type: "LineString",
        coordinates: [
          [-122.0, 37.0],
          [-122.1, 37.1],
        ],
      },
    });
    expect(xml).toContain("<gpx");
    expect(xml).toContain("<trk>");
    expect(xml).toContain("<name>Morning loop</name>");
    expect(xml).toContain('lat="37"');
    expect(xml).toContain('lon="-122"');
  });

  it("returns null when route is missing", () => {
    expect(
      rideToGpx({
        name: "no-route",
        startedAt: new Date(),
        route: null,
      }),
    ).toBeNull();
  });
});

describe("tripDayToGpx", () => {
  it("produces a track per day", () => {
    const xml = tripDayToGpx({
      tripTitle: "CA loop",
      dayNumber: 2,
      route: {
        type: "LineString",
        coordinates: [
          [-1, 1],
          [-2, 2],
        ],
      },
    });
    expect(xml).toContain("<name>CA loop — Day 2</name>");
  });
});
```

- [ ] **Step 2: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- assembler/gpx
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// gpx.ts
import type * as GeoJSON from "geojson";

type LineLike = GeoJSON.LineString | null;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function track(name: string, route: GeoJSON.LineString): string {
  const points = route.coordinates
    .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}" />`)
    .join("");
  return `<trk><name>${escapeXml(name)}</name><trkseg>${points}</trkseg></trk>`;
}

export function rideToGpx(args: {
  name: string;
  startedAt: Date;
  route: LineLike;
}): string | null {
  if (!args.route || args.route.coordinates.length === 0) return null;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="Tarmoto" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<metadata><name>${escapeXml(args.name)}</name>` +
    `<time>${args.startedAt.toISOString()}</time></metadata>` +
    track(args.name, args.route) +
    `</gpx>`
  );
}

export function tripDayToGpx(args: {
  tripTitle: string;
  dayNumber: number;
  route: LineLike;
}): string | null {
  if (!args.route || args.route.coordinates.length === 0) return null;
  const name = `${args.tripTitle} — Day ${args.dayNumber}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="Tarmoto" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<metadata><name>${escapeXml(name)}</name></metadata>` +
    track(name, args.route) +
    `</gpx>`
  );
}
```

- [ ] **Step 4: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- assembler/gpx
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/account/data-export/assembler/gpx.ts \
        apps/backend/src/modules/account/data-export/assembler/gpx.spec.ts
git commit -m "feat(backend): per-ride/per-trip-day gpx helpers for export"
```

---

## Task 7: Bundle assembler (TDD)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/assembler/bundle-assembler.ts`
- Create: `apps/backend/src/modules/account/data-export/assembler/bundle-assembler.spec.ts`

The assembler builds a `Readable` ZIP stream by querying repositories for one user's data and appending each section to an `archiver` archive. Repositories are passed in via constructor so the test can supply mocks.

- [ ] **Step 1: Write the failing test**

```typescript
// bundle-assembler.spec.ts
import { Readable } from "node:stream";
import * as unzipper from "unzipper"; // already a transitive dep of archiver? if not skip — see step 1a
import { BundleAssembler } from "./bundle-assembler.js";
import type { User } from "../../../../entities/user.entity.js";

function makeUser(): User {
  return {
    id: "u1",
    email: "r@example.com",
    password_hash: "h",
    display_name: "R",
    phone: null,
    avatar_url: null,
    bio: null,
    home_region: null,
    home_location: null,
    work_location: null,
    preferences: {},
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_tier: "free",
    subscription_status: "canceled",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  } as unknown as User;
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function listEntries(buf: Buffer): Promise<Map<string, string>> {
  const dir = await unzipper.Open.buffer(buf);
  const out = new Map<string, string>();
  for (const f of dir.files) {
    out.set(f.path, (await f.buffer()).toString("utf8"));
  }
  return out;
}

describe("BundleAssembler", () => {
  it("emits the documented file set when all sources are empty", async () => {
    const user = makeUser();
    const repos = {
      contacts: { find: jest.fn().mockResolvedValue([]) },
      rides: { find: jest.fn().mockResolvedValue([]) },
      rideStats: { find: jest.fn().mockResolvedValue([]) },
      trips: { find: jest.fn().mockResolvedValue([]) },
      tripDays: { find: jest.fn().mockResolvedValue([]) },
      tripMembers: { find: jest.fn().mockResolvedValue([]) },
      reviews: { find: jest.fn().mockResolvedValue([]) },
      hazards: { find: jest.fn().mockResolvedValue([]) },
      badges: { find: jest.fn().mockResolvedValue([]) },
      challenges: { find: jest.fn().mockResolvedValue([]) },
      commute: { find: jest.fn().mockResolvedValue([]) },
    };

    const assembler = new BundleAssembler(repos as never);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);

    const expected = [
      "README.txt",
      "profile.json",
      "bikes.json",
      "contacts.json",
      "preferences.json",
      "privacy.json",
      "notifications.json",
      "rides.json",
      "trips.json",
      "reviews.json",
      "hazard_reports.json",
      "badges.json",
      "challenges.json",
      "commute_routes.json",
    ];
    for (const f of expected) expect(entries.has(f)).toBe(true);

    const profile = JSON.parse(entries.get("profile.json")!);
    expect(profile.email).toBe("r@example.com");
    expect(profile).not.toHaveProperty("password_hash");
    expect(profile).not.toHaveProperty("stripe_customer_id");
  });

  it("includes per-ride GPX files", async () => {
    const user = makeUser();
    const ride = {
      id: "r1",
      user_id: "u1",
      name: "Loop",
      started_at: new Date("2026-04-01T08:00:00Z"),
      route_geom: {
        type: "LineString",
        coordinates: [
          [-1, 1],
          [-2, 2],
        ],
      },
    };
    const repos = {
      contacts: { find: jest.fn().mockResolvedValue([]) },
      rides: { find: jest.fn().mockResolvedValue([ride]) },
      rideStats: { find: jest.fn().mockResolvedValue([]) },
      trips: { find: jest.fn().mockResolvedValue([]) },
      tripDays: { find: jest.fn().mockResolvedValue([]) },
      tripMembers: { find: jest.fn().mockResolvedValue([]) },
      reviews: { find: jest.fn().mockResolvedValue([]) },
      hazards: { find: jest.fn().mockResolvedValue([]) },
      badges: { find: jest.fn().mockResolvedValue([]) },
      challenges: { find: jest.fn().mockResolvedValue([]) },
      commute: { find: jest.fn().mockResolvedValue([]) },
    };
    const assembler = new BundleAssembler(repos as never);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);
    expect(entries.has("rides/r1.gpx")).toBe(true);
    expect(entries.get("rides/r1.gpx")).toContain("<gpx");
  });
});
```

- [ ] **Step 1a: Add `unzipper` as a dev dep for tests only**

Run:

```bash
pnpm --filter @tarmoto/backend add -D unzipper @types/unzipper
```

- [ ] **Step 2: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- bundle-assembler
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// bundle-assembler.ts
import { Readable } from "node:stream";
import archiver from "archiver";
import type { Repository } from "typeorm";
import type { User } from "../../../../entities/user.entity.js";
import type { UserContact } from "../../../../entities/user-contact.entity.js";
import type { Ride } from "../../../../entities/ride.entity.js";
import type { RideStats } from "../../../../entities/ride-stats.entity.js";
import type { Trip } from "../../../../entities/trip.entity.js";
import type { TripDay } from "../../../../entities/trip-day.entity.js";
import type { TripMember } from "../../../../entities/trip-member.entity.js";
import type { RoadReview } from "../../../../entities/road-review.entity.js";
import type { HazardReport } from "../../../../entities/hazard-report.entity.js";
import type { UserBadge } from "../../../../entities/user-badge.entity.js";
import type { ChallengeEntry } from "../../../../entities/challenge-entry.entity.js";
import type { CommuteRoute } from "../../../../entities/commute-route.entity.js";
import { sanitizeUserForExport } from "./sanitizers.js";
import { rideToGpx, tripDayToGpx } from "./gpx.js";

export interface BundleRepos {
  contacts: Pick<Repository<UserContact>, "find">;
  rides: Pick<Repository<Ride>, "find">;
  rideStats: Pick<Repository<RideStats>, "find">;
  trips: Pick<Repository<Trip>, "find">;
  tripDays: Pick<Repository<TripDay>, "find">;
  tripMembers: Pick<Repository<TripMember>, "find">;
  reviews: Pick<Repository<RoadReview>, "find">;
  hazards: Pick<Repository<HazardReport>, "find">;
  badges: Pick<Repository<UserBadge>, "find">;
  challenges: Pick<Repository<ChallengeEntry>, "find">;
  commute: Pick<Repository<CommuteRoute>, "find">;
}

export class BundleAssembler {
  constructor(private readonly repos: BundleRepos) {}

  async assemble(user: User): Promise<Readable> {
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => archive.emit("error", err));

    const userId = user.id;

    const [
      contacts,
      rides,
      trips,
      tripDays,
      tripMembers,
      reviews,
      hazards,
      badges,
      challenges,
      commute,
    ] = await Promise.all([
      this.repos.contacts.find({ where: { user_id: userId } }),
      this.repos.rides.find({
        where: { user_id: userId },
        order: { started_at: "DESC" },
      }),
      this.repos.trips.find({ where: { owner_id: userId } }),
      this.repos.tripDays.find({}),
      this.repos.tripMembers.find({ where: { user_id: userId } }),
      this.repos.reviews.find({ where: { user_id: userId } }),
      this.repos.hazards.find({ where: { user_id: userId } }),
      this.repos.badges.find({ where: { user_id: userId } }),
      this.repos.challenges.find({ where: { user_id: userId } }),
      this.repos.commute.find({ where: { user_id: userId } }),
    ]);

    const ownedTripIds = new Set(trips.map((t) => t.id));
    const memberTripIds = new Set(tripMembers.map((m) => m.trip_id));
    const allTripIds = new Set<string>([...ownedTripIds, ...memberTripIds]);
    const visibleDays = tripDays.filter((d) => allTripIds.has(d.trip_id));

    const rideIds = rides.map((r) => r.id);
    const rideStats = rideIds.length
      ? await this.repos.rideStats.find({
          where: rideIds.map((id) => ({ ride_id: id })),
        })
      : [];

    const sanitizedProfile = sanitizeUserForExport(user);
    const generatedAt = new Date().toISOString();

    archive.append(buildReadme(generatedAt), { name: "README.txt" });
    archive.append(json(sanitizedProfile), { name: "profile.json" });
    archive.append(json([]), { name: "bikes.json" });
    archive.append(json(contacts), { name: "contacts.json" });
    archive.append(json(user.preferences ?? {}), {
      name: "preferences.json",
    });
    archive.append(json(extractPrivacy(user)), { name: "privacy.json" });
    archive.append(json(extractNotifications(user)), {
      name: "notifications.json",
    });
    archive.append(json({ rides, stats: rideStats }), { name: "rides.json" });
    archive.append(
      json({ trips, days: visibleDays, memberships: tripMembers }),
      { name: "trips.json" },
    );
    archive.append(json(reviews), { name: "reviews.json" });
    archive.append(json(hazards), { name: "hazard_reports.json" });
    archive.append(json(badges), { name: "badges.json" });
    archive.append(json(challenges), { name: "challenges.json" });
    archive.append(json(commute), { name: "commute_routes.json" });

    for (const r of rides) {
      const gpx = rideToGpx({
        name: r.name ?? `ride-${r.id}`,
        startedAt: r.started_at,
        route:
          (r as { route_geom?: GeoJSON.LineString | null }).route_geom ?? null,
      });
      if (gpx) archive.append(gpx, { name: `rides/${r.id}.gpx` });
    }

    for (const day of visibleDays) {
      const trip = trips.find((t) => t.id === day.trip_id);
      const gpx = tripDayToGpx({
        tripTitle: trip?.title ?? `trip-${day.trip_id}`,
        dayNumber: (day as { day_number: number }).day_number,
        route:
          (day as { route_geom?: GeoJSON.LineString | null }).route_geom ??
          null,
      });
      if (gpx) {
        archive.append(gpx, {
          name: `trips/${day.trip_id}/day-${(day as { day_number: number }).day_number}.gpx`,
        });
      }
    }

    archive.finalize();
    return archive;
  }
}

function json(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function buildReadme(generatedAt: string): string {
  return [
    "Tarmoto data export",
    `Generated: ${generatedAt}`,
    "",
    "This bundle contains the personal data Tarmoto holds about your account,",
    "in fulfillment of GDPR Article 15.",
    "",
    "Files included:",
    "  profile.json         - account profile (password hash and Stripe IDs removed)",
    "  bikes.json           - garage entries (empty until bike entity ships)",
    "  contacts.json        - emergency contacts",
    "  preferences.json     - user preferences blob",
    "  privacy.json         - privacy settings derived from preferences",
    "  notifications.json   - notification settings derived from preferences",
    "  rides.json           - ride metadata + per-ride stats",
    "  rides/<id>.gpx       - GPX track per ride with a route",
    "  trips.json           - trip metadata + days + your memberships",
    "  trips/<id>/day-N.gpx - GPX track per planned trip day",
    "  reviews.json         - your road reviews (photo URLs included; binaries not bundled)",
    "  hazard_reports.json  - hazards you submitted",
    "  badges.json          - badges you earned",
    "  challenges.json      - challenge entries",
    "  commute_routes.json  - your saved commute routes",
    "",
    "Anonymized road quality contributions are NOT included because they no",
    "longer reference your account after anonymization.",
    "",
    "The download link for this bundle expires 7 days after generation.",
    "",
  ].join("\n");
}

function extractPrivacy(user: User): Record<string, unknown> {
  const prefs = (user.preferences ?? {}) as Record<string, unknown>;
  return (prefs.privacy as Record<string, unknown>) ?? {};
}

function extractNotifications(user: User): Record<string, unknown> {
  const prefs = (user.preferences ?? {}) as Record<string, unknown>;
  return (prefs.notifications as Record<string, unknown>) ?? {};
}
```

- [ ] **Step 4: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- bundle-assembler
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/account/data-export/assembler/bundle-assembler.ts \
        apps/backend/src/modules/account/data-export/assembler/bundle-assembler.spec.ts \
        apps/backend/package.json pnpm-lock.yaml
git commit -m "feat(backend): zip bundle assembler for gdpr export"
```

---

## Task 8: `DataExportService` (idempotency, signed URL, status)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/data-export.service.ts`
- Create: `apps/backend/src/modules/account/data-export/data-export.service.spec.ts`
- Create: `apps/backend/src/modules/account/data-export/dto/data-export-request.dto.ts`

Behavior:

- `requestExport(userId)` — if an active row exists (`queued|processing|ready` and not past `expires_at`) return it; else insert a new row with `expires_at = now + 7d` and return `{ created: true, request }`.
- `getRequest(userId, id)` — returns the row + the public payload (status, expires_at, downloadUrl when ready).
- `markProcessing(id)`, `markReady(id, key, byteSize)`, `markFailed(id, error)` — used by processor.
- `buildPublicView(request, baseUrl)` — produces the response DTO, including a signed download URL when ready.

- [ ] **Step 1: Write the DTO**

```typescript
// dto/data-export-request.dto.ts
import { ApiProperty } from "@nestjs/swagger";

export class DataExportRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    enum: ["queued", "processing", "ready", "failed", "expired"],
  })
  status!: "queued" | "processing" | "ready" | "failed" | "expired";
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time", nullable: true })
  completedAt!: string | null;
  @ApiProperty({ nullable: true }) downloadUrl!: string | null;
  @ApiProperty({ nullable: true }) byteSize!: number | null;
  @ApiProperty({ nullable: true }) errorMessage!: string | null;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// data-export.service.spec.ts
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataExportService } from "./data-export.service.js";
import { DataExportRequest } from "../../../entities/data-export-request.entity.js";

describe("DataExportService", () => {
  let service: DataExportService;
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => ({ ...x, id: x.id ?? "req-new" })),
    update: jest.fn(),
  };
  const config = {
    get: jest.fn((k: string) => {
      if (k === "TARMOTO_EXPORT_SIGNING_SECRET") return "test-secret";
      if (k === "TARMOTO_PUBLIC_BASE_URL") return "https://api.example.com";
      return undefined;
    }),
  };

  beforeEach(async () => {
    repo.findOne.mockReset();
    repo.save.mockClear();
    repo.update.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: getRepositoryToken(DataExportRequest), useValue: repo },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(DataExportService);
  });

  it("creates a new request when none active", async () => {
    repo.findOne.mockResolvedValue(null);
    const out = await service.requestExport("u1");
    expect(out.created).toBe(true);
    expect(repo.save).toHaveBeenCalled();
    expect(out.request.user_id).toBe("u1");
    expect(out.request.status).toBe("queued");
  });

  it("returns the existing request when one is active", async () => {
    const existing = {
      id: "req-1",
      user_id: "u1",
      status: "processing",
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      storage_key: null,
      byte_size: null,
      error_message: null,
    } as DataExportRequest;
    repo.findOne.mockResolvedValue(existing);
    const out = await service.requestExport("u1");
    expect(out.created).toBe(false);
    expect(out.request.id).toBe("req-1");
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("emits a signed download URL when status is ready", () => {
    const req = {
      id: "req-1",
      user_id: "u1",
      status: "ready",
      storage_key: "u1/req-1.zip",
      byte_size: "123",
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: new Date(),
      error_message: null,
    } as DataExportRequest;
    const view = service.buildPublicView(req);
    expect(view.downloadUrl).toMatch(
      /^https:\/\/api\.example\.com\/account\/data-export\/req-1\/download\?sig=[a-f0-9]+&exp=\d+$/,
    );
    expect(view.byteSize).toBe(123);
  });

  it("omits download URL for non-ready statuses", () => {
    const req = {
      id: "req-1",
      user_id: "u1",
      status: "queued",
      storage_key: null,
      byte_size: null,
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      error_message: null,
    } as DataExportRequest;
    const view = service.buildPublicView(req);
    expect(view.downloadUrl).toBeNull();
  });
});
```

- [ ] **Step 3: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.service
```

Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
// data-export.service.ts
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { DataExportRequest } from "../../../entities/data-export-request.entity.js";
import { DataExportRequestDto } from "./dto/data-export-request.dto.js";
import { signDownloadUrl } from "./signed-url.js";

const ACTIVE: DataExportRequest["status"][] = ["queued", "processing", "ready"];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class DataExportService {
  constructor(
    @InjectRepository(DataExportRequest)
    private readonly repo: Repository<DataExportRequest>,
    private readonly config: ConfigService,
  ) {}

  async requestExport(
    userId: string,
  ): Promise<{ created: boolean; request: DataExportRequest }> {
    const active = await this.repo.findOne({
      where: { user_id: userId, status: In(ACTIVE) },
      order: { created_at: "DESC" },
    });
    if (active && active.expires_at.getTime() > Date.now()) {
      return { created: false, request: active };
    }
    const draft = this.repo.create({
      user_id: userId,
      status: "queued",
      expires_at: new Date(Date.now() + TTL_MS),
    });
    const saved = await this.repo.save(draft);
    return { created: true, request: saved };
  }

  async getRequest(
    userId: string,
    id: string,
  ): Promise<DataExportRequest | null> {
    return this.repo.findOne({ where: { id, user_id: userId } });
  }

  async markProcessing(id: string): Promise<void> {
    await this.repo.update({ id }, { status: "processing" });
  }

  async markReady(
    id: string,
    storageKey: string,
    byteSize: number,
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        status: "ready",
        storage_key: storageKey,
        byte_size: String(byteSize),
        completed_at: new Date(),
      },
    );
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.repo.update(
      { id },
      { status: "failed", error_message: message.slice(0, 1000) },
    );
  }

  buildPublicView(request: DataExportRequest): DataExportRequestDto {
    let downloadUrl: string | null = null;
    if (request.status === "ready") {
      const exp = request.expires_at.getTime();
      const sig = signDownloadUrl({
        requestId: request.id,
        expiresAt: exp,
        secret: this.signingSecret(),
      });
      downloadUrl = `${this.publicBaseUrl()}/account/data-export/${request.id}/download?sig=${sig}&exp=${exp}`;
    }
    return {
      id: request.id,
      status: request.status,
      expiresAt: request.expires_at.toISOString(),
      createdAt: request.created_at.toISOString(),
      completedAt: request.completed_at?.toISOString() ?? null,
      downloadUrl,
      byteSize: request.byte_size ? Number(request.byte_size) : null,
      errorMessage: request.error_message,
    };
  }

  signingSecret(): string {
    const v = this.config.get<string>("TARMOTO_EXPORT_SIGNING_SECRET");
    if (!v) {
      throw new Error("TARMOTO_EXPORT_SIGNING_SECRET is not configured");
    }
    return v;
  }

  private publicBaseUrl(): string {
    return (
      this.config.get<string>("TARMOTO_PUBLIC_BASE_URL") ??
      "http://localhost:3000"
    );
  }
}
```

- [ ] **Step 5: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.service
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/account/data-export/data-export.service.ts \
        apps/backend/src/modules/account/data-export/data-export.service.spec.ts \
        apps/backend/src/modules/account/data-export/dto/
git commit -m "feat(backend): data-export service with idempotency + signed urls"
```

---

## Task 9: `DataExportProcessor` (in-process worker)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/data-export.processor.ts`
- Create: `apps/backend/src/modules/account/data-export/data-export.processor.spec.ts`

Behavior: `process(requestId, userId)` — load user, build assembler, write archive stream to storage, update row. Logs errors and calls `markFailed` on throw.

- [ ] **Step 1: Write the failing test**

```typescript
// data-export.processor.spec.ts
import { Readable } from "node:stream";
import { DataExportProcessor } from "./data-export.processor.js";

describe("DataExportProcessor", () => {
  const baseUser = { id: "u1", email: "r@example.com" };
  const usersRepo = { findOne: jest.fn() };
  const service = {
    markProcessing: jest.fn(),
    markReady: jest.fn(),
    markFailed: jest.fn(),
  };
  const storage = {
    write: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };
  const assembler = {
    assemble: jest.fn(),
  };
  const logger = { error: jest.fn(), log: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("writes the archive to storage and marks ready", async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockResolvedValue(Readable.from(Buffer.from("zip")));
    storage.write.mockResolvedValue({ byteSize: 3 });

    const processor = new DataExportProcessor(
      usersRepo as never,
      service as never,
      storage as never,
      assembler as never,
      logger as never,
    );
    await processor.process("req-1", "u1");

    expect(service.markProcessing).toHaveBeenCalledWith("req-1");
    expect(storage.write).toHaveBeenCalledWith(
      "u1/req-1.zip",
      expect.any(Readable),
    );
    expect(service.markReady).toHaveBeenCalledWith("req-1", "u1/req-1.zip", 3);
    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it("marks failed on assembler error", async () => {
    usersRepo.findOne.mockResolvedValue(baseUser);
    assembler.assemble.mockRejectedValue(new Error("boom"));

    const processor = new DataExportProcessor(
      usersRepo as never,
      service as never,
      storage as never,
      assembler as never,
      logger as never,
    );
    await processor.process("req-1", "u1");

    expect(service.markFailed).toHaveBeenCalledWith("req-1", "boom");
    expect(service.markReady).not.toHaveBeenCalled();
  });

  it("marks failed when user is missing", async () => {
    usersRepo.findOne.mockResolvedValue(null);
    const processor = new DataExportProcessor(
      usersRepo as never,
      service as never,
      storage as never,
      assembler as never,
      logger as never,
    );
    await processor.process("req-1", "u1");
    expect(service.markFailed).toHaveBeenCalledWith(
      "req-1",
      expect.stringContaining("user not found"),
    );
  });
});
```

- [ ] **Step 2: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.processor
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// data-export.processor.ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../../../entities/user.entity.js";
import { DataExportService } from "./data-export.service.js";
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from "./storage/export-storage.interface.js";
import { BundleAssembler } from "./assembler/bundle-assembler.js";

@Injectable()
export class DataExportProcessor {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly service: DataExportService,
    @Inject(EXPORT_STORAGE)
    private readonly storage: ExportStorage,
    private readonly assembler: BundleAssembler,
    private readonly logger: Logger = new Logger(DataExportProcessor.name),
  ) {}

  async process(requestId: string, userId: string): Promise<void> {
    try {
      await this.service.markProcessing(requestId);
      const user = await this.users.findOne({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          display_name: true,
          phone: true,
          avatar_url: true,
          bio: true,
          home_region: true,
          home_location: true,
          work_location: true,
          preferences: true,
          subscription_tier: true,
          subscription_status: true,
          created_at: true,
          updated_at: true,
        },
      });
      if (!user) {
        await this.service.markFailed(requestId, "user not found");
        return;
      }
      const archiveStream = await this.assembler.assemble(user);
      const key = `${userId}/${requestId}.zip`;
      const { byteSize } = await this.storage.write(key, archiveStream);
      await this.service.markReady(requestId, key, byteSize);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`export ${requestId} failed: ${msg}`);
      await this.service.markFailed(requestId, msg);
    }
  }
}
```

- [ ] **Step 4: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.processor
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/account/data-export/data-export.processor.ts \
        apps/backend/src/modules/account/data-export/data-export.processor.spec.ts
git commit -m "feat(backend): in-process data-export worker"
```

---

## Task 10: `DataExportController` (3 endpoints)

**Files:**

- Create: `apps/backend/src/modules/account/data-export/data-export.controller.ts`
- Create: `apps/backend/src/modules/account/data-export/data-export.controller.spec.ts`

Endpoints (all under controller prefix `account/data-export`):

- `POST /account/data-export` (auth required) — calls `service.requestExport`, then `setImmediate(() => processor.process(...))` so the worker runs after the response. Returns 202 on creation, 200 on idempotent reuse.
- `GET /account/data-export/:id` (auth required) — `service.getRequest` + `buildPublicView`. 404 if the row doesn't belong to the caller.
- `GET /account/data-export/:id/download` (no auth — signature is the auth) — verify `?sig=...&exp=...`, load row, refuse if not `ready` or expired, stream from storage with attachment headers.

- [ ] **Step 1: Write the failing tests**

```typescript
// data-export.controller.spec.ts
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { Readable } from "node:stream";
import { DataExportController } from "./data-export.controller.js";
import { DataExportService } from "./data-export.service.js";
import { DataExportProcessor } from "./data-export.processor.js";
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from "./storage/export-storage.interface.js";
import { signDownloadUrl } from "./signed-url.js";

describe("DataExportController", () => {
  let controller: DataExportController;
  const service = {
    requestExport: jest.fn(),
    getRequest: jest.fn(),
    buildPublicView: jest.fn((r: { id: string; status: string }) => ({
      id: r.id,
      status: r.status,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      completedAt: null,
      downloadUrl: null,
      byteSize: null,
      errorMessage: null,
    })),
    signingSecret: () => "test-secret",
  };
  const processor = { process: jest.fn().mockResolvedValue(undefined) };
  const storage: ExportStorage = {
    write: jest.fn(),
    read: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [DataExportController],
      providers: [
        { provide: DataExportService, useValue: service },
        { provide: DataExportProcessor, useValue: processor },
        { provide: EXPORT_STORAGE, useValue: storage },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
      ],
    }).compile();
    controller = module.get(DataExportController);
  });

  it("returns 202 + dispatches worker on a fresh request", async () => {
    const req = { id: "req-1", user_id: "u1", status: "queued" };
    service.requestExport.mockResolvedValue({ created: true, request: req });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: "u1" } } as never, res as never);
    expect(service.requestExport).toHaveBeenCalledWith("u1");
    expect(res.status).toHaveBeenCalledWith(202);
    // Worker is dispatched async; wait a tick.
    await new Promise(setImmediate);
    expect(processor.process).toHaveBeenCalledWith("req-1", "u1");
  });

  it("returns 200 when reusing an active request", async () => {
    const req = { id: "req-1", user_id: "u1", status: "ready" };
    service.requestExport.mockResolvedValue({ created: false, request: req });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await controller.create({ user: { userId: "u1" } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it("GET status returns 404 when not owned by caller", async () => {
    service.getRequest.mockResolvedValue(null);
    await expect(
      controller.get({ user: { userId: "u1" } } as never, "req-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("GET download streams the archive when signature is valid", async () => {
    const requestId = "req-1";
    const expiresAt = Date.now() + 60_000;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: "test-secret",
    });
    service.getRequest.mockResolvedValue({
      id: requestId,
      user_id: "u1",
      status: "ready",
      storage_key: "u1/req-1.zip",
      expires_at: new Date(expiresAt),
    });
    (storage.read as jest.Mock).mockResolvedValue(
      Readable.from(Buffer.from("zipdata")),
    );
    const res = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const stream = { pipe: jest.fn() };
    (storage.read as jest.Mock).mockResolvedValue(stream);
    await controller.download(requestId, sig, String(expiresAt), res as never);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/zip");
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });

  it("GET download rejects bad signature with 403", async () => {
    const requestId = "req-1";
    const expiresAt = Date.now() + 60_000;
    service.getRequest.mockResolvedValue({
      id: requestId,
      user_id: "u1",
      status: "ready",
      storage_key: "u1/req-1.zip",
      expires_at: new Date(expiresAt),
    });
    await expect(
      controller.download(requestId, "badsig", String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("GET download rejects expired signature with 410", async () => {
    const requestId = "req-1";
    const expiresAt = Date.now() - 1;
    const sig = signDownloadUrl({
      requestId,
      expiresAt,
      secret: "test-secret",
    });
    service.getRequest.mockResolvedValue({
      id: requestId,
      user_id: "u1",
      status: "ready",
      storage_key: "u1/req-1.zip",
      expires_at: new Date(expiresAt),
    });
    await expect(
      controller.download(requestId, sig, String(expiresAt), {
        set: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
      } as never),
    ).rejects.toMatchObject({ status: 410 });
  });
});
```

- [ ] **Step 2: Verify failing**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.controller
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// data-export.controller.ts
import {
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type * as express from "express";
import { AuthGuard } from "../../auth/auth.guard.js";
import { DataExportProcessor } from "./data-export.processor.js";
import { DataExportService } from "./data-export.service.js";
import { DataExportRequestDto } from "./dto/data-export-request.dto.js";
import {
  EXPORT_STORAGE,
  type ExportStorage,
} from "./storage/export-storage.interface.js";
import { verifyDownloadSignature } from "./signed-url.js";

@ApiTags("account")
@Controller("account/data-export")
export class DataExportController {
  constructor(
    private readonly service: DataExportService,
    private readonly processor: DataExportProcessor,
    @Inject(EXPORT_STORAGE)
    private readonly storage: ExportStorage,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Request a GDPR data export bundle for the caller",
    description:
      "Returns 202 if a new request was created, 200 if an active request already exists. The bundle is assembled asynchronously and surfaced via GET /account/data-export/:id.",
  })
  @ApiResponse({ status: 202, type: DataExportRequestDto })
  @ApiResponse({ status: 200, type: DataExportRequestDto })
  async create(
    @Req() req: express.Request,
    @Res() res: express.Response,
  ): Promise<void> {
    const userId = req.user!.userId;
    const { created, request } = await this.service.requestExport(userId);
    const view = this.service.buildPublicView(request);
    if (created) {
      setImmediate(() => {
        void this.processor.process(request.id, userId);
      });
      res.status(202).json(view);
    } else {
      res.status(200).json(view);
    }
  }

  @Get(":id")
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the status of a data export request" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 200, type: DataExportRequestDto })
  @ApiResponse({ status: 404 })
  async get(
    @Req() req: express.Request,
    @Param("id") id: string,
  ): Promise<DataExportRequestDto> {
    const userId = req.user!.userId;
    const row = await this.service.getRequest(userId, id);
    if (!row) {
      throw new HttpException("not found", 404);
    }
    return this.service.buildPublicView(row);
  }

  @Get(":id/download")
  @ApiOperation({
    summary: "Download a ready data export bundle (signed URL)",
    description:
      "Authenticated via signed URL produced by the create/get endpoints; bearer auth not required.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 200, description: "application/zip stream" })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 410 })
  async download(
    @Param("id") id: string,
    @Query("sig") signature: string,
    @Query("exp") expiresAtRaw: string,
    @Res() res: express.Response,
  ): Promise<void> {
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || !signature) {
      throw new HttpException("missing signature", 403);
    }
    const verdict = verifyDownloadSignature({
      requestId: id,
      expiresAt,
      signature,
      secret: this.service.signingSecret(),
    });
    if (verdict === "expired") {
      throw new HttpException("link expired", 410);
    }
    if (verdict !== "valid") {
      throw new HttpException("invalid signature", 403);
    }

    // Find the row without scoping by user (signature is the auth).
    // We still need it to look up the storage key + verify status.
    const row = await this.service.findById(id);
    if (!row || row.status !== "ready" || !row.storage_key) {
      throw new HttpException("not available", 410);
    }
    if (row.expires_at.getTime() < Date.now()) {
      throw new HttpException("link expired", 410);
    }

    const stream = await this.storage.read(row.storage_key);
    res.set("Content-Type", "application/zip");
    res.set(
      "Content-Disposition",
      `attachment; filename="tarmoto-export-${id}.zip"`,
    );
    stream.pipe(res);
  }
}
```

> Note: This uses `service.findById(id)` (no user scoping) — add that method to `DataExportService` in this same task. The signature is what authorizes the download, so the row lookup must not require a session.

- [ ] **Step 4: Add `findById` to the service**

In `data-export.service.ts`, add:

```typescript
async findById(id: string): Promise<DataExportRequest | null> {
  return this.repo.findOne({ where: { id } });
}
```

- [ ] **Step 5: Tests pass**

Run:

```bash
pnpm --filter @tarmoto/backend test -- data-export.controller
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/account/data-export/data-export.controller.ts \
        apps/backend/src/modules/account/data-export/data-export.controller.spec.ts \
        apps/backend/src/modules/account/data-export/data-export.service.ts
git commit -m "feat(backend): data-export endpoints (POST + GET status + GET download)"
```

---

## Task 11: `DataExportModule` + wire into `AccountModule`

**Files:**

- Create: `apps/backend/src/modules/account/data-export/data-export.module.ts`
- Modify: `apps/backend/src/modules/account/account.module.ts`

- [ ] **Step 1: Write the module**

```typescript
// data-export.module.ts
import { Module, Logger } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { User } from "../../../entities/user.entity.js";
import { UserContact } from "../../../entities/user-contact.entity.js";
import { Ride } from "../../../entities/ride.entity.js";
import { RideStats } from "../../../entities/ride-stats.entity.js";
import { Trip } from "../../../entities/trip.entity.js";
import { TripDay } from "../../../entities/trip-day.entity.js";
import { TripMember } from "../../../entities/trip-member.entity.js";
import { RoadReview } from "../../../entities/road-review.entity.js";
import { HazardReport } from "../../../entities/hazard-report.entity.js";
import { UserBadge } from "../../../entities/user-badge.entity.js";
import { ChallengeEntry } from "../../../entities/challenge-entry.entity.js";
import { CommuteRoute } from "../../../entities/commute-route.entity.js";
import { DataExportRequest } from "../../../entities/data-export-request.entity.js";
import { AuthModule } from "../../auth/index.js";
import { DataExportController } from "./data-export.controller.js";
import { DataExportService } from "./data-export.service.js";
import { DataExportProcessor } from "./data-export.processor.js";
import { BundleAssembler } from "./assembler/bundle-assembler.js";
import { LocalExportStorage } from "./storage/local-export-storage.js";
import { EXPORT_STORAGE } from "./storage/export-storage.interface.js";
import { getRepositoryToken } from "@nestjs/typeorm";

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    TypeOrmModule.forFeature([
      DataExportRequest,
      User,
      UserContact,
      Ride,
      RideStats,
      Trip,
      TripDay,
      TripMember,
      RoadReview,
      HazardReport,
      UserBadge,
      ChallengeEntry,
      CommuteRoute,
    ]),
  ],
  controllers: [DataExportController],
  providers: [
    DataExportService,
    DataExportProcessor,
    Logger,
    {
      provide: EXPORT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LocalExportStorage(
          config.get<string>("TARMOTO_EXPORT_STORAGE_DIR") ??
            join(tmpdir(), "tarmoto-exports"),
        ),
    },
    {
      provide: BundleAssembler,
      inject: [
        getRepositoryToken(UserContact),
        getRepositoryToken(Ride),
        getRepositoryToken(RideStats),
        getRepositoryToken(Trip),
        getRepositoryToken(TripDay),
        getRepositoryToken(TripMember),
        getRepositoryToken(RoadReview),
        getRepositoryToken(HazardReport),
        getRepositoryToken(UserBadge),
        getRepositoryToken(ChallengeEntry),
        getRepositoryToken(CommuteRoute),
      ],
      useFactory: (
        contacts,
        rides,
        rideStats,
        trips,
        tripDays,
        tripMembers,
        reviews,
        hazards,
        badges,
        challenges,
        commute,
      ) =>
        new BundleAssembler({
          contacts,
          rides,
          rideStats,
          trips,
          tripDays,
          tripMembers,
          reviews,
          hazards,
          badges,
          challenges,
          commute,
        }),
    },
  ],
})
export class DataExportModule {}
```

- [ ] **Step 2: Wire into AccountModule**

Edit `apps/backend/src/modules/account/account.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../../entities/user.entity.js";
import { AccountController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import {
  STRIPE_BILLING_CLIENT,
  StripeNodeBillingClient,
} from "./stripe-billing.client.js";
import { DataExportModule } from "./data-export/data-export.module.js";

@Module({
  imports: [TypeOrmModule.forFeature([User]), DataExportModule],
  controllers: [AccountController],
  providers: [
    AccountService,
    StripeNodeBillingClient,
    {
      provide: STRIPE_BILLING_CLIENT,
      useExisting: StripeNodeBillingClient,
    },
  ],
})
export class AccountModule {}
```

- [ ] **Step 3: Boot smoke test**

Run:

```bash
pnpm --filter @tarmoto/backend build
```

Expected: build succeeds, no TypeScript errors.

```bash
TARMOTO_EXPORT_SIGNING_SECRET=dev-secret pnpm --filter @tarmoto/backend exec node -e "
  require('./dist/main.js');
"
```

Wait 5s, then Ctrl+C. Expected: server starts and reaches "Application is running" without crashing on the new module.

(If a manual smoke test isn't practical, skip — Task 13 e2e covers it.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/modules/account/data-export/data-export.module.ts \
        apps/backend/src/modules/account/account.module.ts
git commit -m "feat(backend): wire DataExportModule into AccountModule"
```

---

## Task 12: End-to-end smoke test (real DB, real ZIP)

**Files:**

- Create: `apps/backend/test/data-export.e2e-spec.ts`

This test boots the full Nest app with the real database, creates a user, hits POST then polls GET, then downloads the ZIP and asserts the entry list.

- [ ] **Step 1: Write the e2e test**

```typescript
// apps/backend/test/data-export.e2e-spec.ts
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import * as unzipper from "unzipper";
import { AppModule } from "../src/app.module.js";
import { JwtService } from "@nestjs/jwt";
import { DataSource } from "typeorm";

jest.setTimeout(30_000);

describe("GDPR data export (e2e)", () => {
  let app: INestApplication;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    process.env.TARMOTO_EXPORT_SIGNING_SECRET = "e2e-secret";
    process.env.TARMOTO_EXPORT_STORAGE_DIR = `/tmp/tarmoto-export-e2e-${Date.now()}`;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const ds = app.get(DataSource);
    const insert = await ds.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [`e2e-${Date.now()}@example.com`, "x", "E2E Rider"],
    );
    userId = insert[0].id;

    const jwt = app.get(JwtService);
    token = await jwt.signAsync({ sub: userId, type: "access" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates, polls until ready, then downloads a valid ZIP", async () => {
    const created = await request(app.getHttpServer())
      .post("/account/data-export")
      .set("Authorization", `Bearer ${token}`)
      .expect(202);
    const requestId: string = created.body.id;
    expect(created.body.status).toBe("queued");

    let view = created.body;
    for (let i = 0; i < 30 && view.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const poll = await request(app.getHttpServer())
        .get(`/account/data-export/${requestId}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      view = poll.body;
      if (view.status === "failed") {
        throw new Error(`export failed: ${view.errorMessage}`);
      }
    }
    expect(view.status).toBe("ready");
    expect(view.downloadUrl).toMatch(/\/account\/data-export\/.+\/download/);

    const url = new URL(view.downloadUrl);
    const dl = await request(app.getHttpServer())
      .get(`${url.pathname}${url.search}`)
      .expect(200)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    const dir = await unzipper.Open.buffer(dl.body as Buffer);
    const names = dir.files.map((f) => f.path);
    expect(names).toEqual(
      expect.arrayContaining([
        "README.txt",
        "profile.json",
        "contacts.json",
        "rides.json",
        "trips.json",
      ]),
    );
  });

  it("returns the same row on a duplicate request (rate limit)", async () => {
    const first = await request(app.getHttpServer())
      .post("/account/data-export")
      .set("Authorization", `Bearer ${token}`);
    const second = await request(app.getHttpServer())
      .post("/account/data-export")
      .set("Authorization", `Bearer ${token}`);
    expect([200, 202]).toContain(second.status);
    expect(second.body.id).toBe(first.body.id);
  });

  it("rejects download with bad signature", async () => {
    const created = await request(app.getHttpServer())
      .post("/account/data-export")
      .set("Authorization", `Bearer ${token}`);
    const id = created.body.id;
    await request(app.getHttpServer())
      .get(
        `/account/data-export/${id}/download?sig=bad&exp=${Date.now() + 60_000}`,
      )
      .expect(403);
  });
});
```

- [ ] **Step 2: Run e2e**

Ensure DB is up: `pnpm db:up && pnpm db:migrate`.

Run:

```bash
pnpm --filter @tarmoto/backend test:e2e -- data-export
```

Expected: 3 passed.

If this fails because `test/jest-e2e.json` excludes the file, mirror the existing pattern (look at sibling `*.e2e-spec.ts` files; the config at `apps/backend/test/jest-e2e.json` typically picks up all `*.e2e-spec.ts`). Adjust if needed and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/test/data-export.e2e-spec.ts
git commit -m "test(backend): e2e gdpr data export round-trip"
```

---

## Task 13: Regenerate OpenAPI

**Files:**

- Modify: `packages/openapi/openapi.yaml`, `packages/openapi/types.ts`

- [ ] **Step 1: Set required env for export**

In `apps/backend/src/scripts/export-openapi.ts` no env should be required, but `DataExportService` reads `TARMOTO_EXPORT_SIGNING_SECRET` lazily via `signingSecret()` — only on hot paths, not at module init. So OpenAPI export should boot cleanly. If it doesn't, add a default in the factory.

Run:

```bash
pnpm --filter @tarmoto/openapi generate
```

- [ ] **Step 2: Verify the new paths appear**

Run:

```bash
grep -n "data-export" packages/openapi/openapi.yaml | head -20
```

Expected: at least 3 lines (POST, GET, GET download).

- [ ] **Step 3: Commit**

```bash
git add packages/openapi/openapi.yaml packages/openapi/types.ts
git commit -m "chore(openapi): regenerate for data-export endpoints"
```

---

## Task 14: Companion API client + UI polling

**Files:**

- Modify: `apps/companion/src/lib/api.ts`
- Modify: `apps/companion/src/app/(dashboard)/settings/data/page.tsx`

- [ ] **Step 1: Update the API client**

Edit `apps/companion/src/lib/api.ts`. Replace the existing `exportData` line with:

```typescript
export interface DataExportRequestView {
  id: string;
  status: "queued" | "processing" | "ready" | "failed" | "expired";
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
  byteSize: number | null;
  errorMessage: string | null;
}

export const accountApi = {
  // ... keep existing entries ...
  requestDataExport: () =>
    apiFetch<DataExportRequestView>("/account/data-export", {
      method: "POST",
    }),
  getDataExport: (id: string) =>
    apiFetch<DataExportRequestView>(`/account/data-export/${id}`),
  // ... keep the rest ...
};
```

Remove the old `exportData: () => apiFetch("/account/export", { method: "POST" }),` line.

- [ ] **Step 2: Update the settings page**

Edit `apps/companion/src/app/(dashboard)/settings/data/page.tsx`. Replace the export-state machine to handle the new flow:

```tsx
type ExportState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "polling"; id: string }
  | { kind: "ready"; id: string; downloadUrl: string }
  | { kind: "failed"; message: string };

const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });

async function requestExport() {
  if (exportState.kind === "requesting" || exportState.kind === "polling")
    return;
  setExportState({ kind: "requesting" });
  try {
    const view = await accountApi.requestDataExport();
    if (view.status === "ready" && view.downloadUrl) {
      setExportState({
        kind: "ready",
        id: view.id,
        downloadUrl: view.downloadUrl,
      });
    } else {
      setExportState({ kind: "polling", id: view.id });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not start export";
    setExportState({ kind: "failed", message });
  }
}

useEffect(() => {
  if (exportState.kind !== "polling") return;
  let cancelled = false;
  const tick = async () => {
    try {
      const view = await accountApi.getDataExport(exportState.id);
      if (cancelled) return;
      if (view.status === "ready" && view.downloadUrl) {
        setExportState({
          kind: "ready",
          id: view.id,
          downloadUrl: view.downloadUrl,
        });
      } else if (view.status === "failed") {
        setExportState({
          kind: "failed",
          message: view.errorMessage ?? "Export failed",
        });
      }
    } catch (err) {
      if (cancelled) return;
      setExportState({
        kind: "failed",
        message: err instanceof Error ? err.message : "Polling failed",
      });
    }
  };
  const interval = setInterval(tick, 2000);
  void tick();
  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}, [exportState]);
```

In the JSX where the status is displayed, render the variants:

```tsx
{
  exportState.kind === "requesting" && <p>Starting export…</p>;
}
{
  exportState.kind === "polling" && (
    <p>Assembling your data… this usually takes under a minute.</p>
  );
}
{
  exportState.kind === "ready" && (
    <a href={exportState.downloadUrl} className="…existing classes…" download>
      Download your data (link expires in 7 days)
    </a>
  );
}
{
  exportState.kind === "failed" && (
    <p className="text-red-600">Export failed: {exportState.message}</p>
  );
}
```

(Match the existing Tailwind classes from the surrounding markup.)

- [ ] **Step 3: Type check + lint**

Run:

```bash
pnpm --filter @tarmoto/companion lint
pnpm --filter @tarmoto/companion build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/companion/src/lib/api.ts \
        apps/companion/src/app/\(dashboard\)/settings/data/page.tsx
git commit -m "feat(companion): wire data export polling + download link"
```

---

## Task 15: Final validation + open PR

- [ ] **Step 1: Run the full backend test suite**

```bash
pnpm --filter @tarmoto/backend test
pnpm --filter @tarmoto/backend lint
pnpm --filter @tarmoto/backend build
```

Expected: all green.

- [ ] **Step 2: Run the e2e test once more**

```bash
pnpm --filter @tarmoto/backend test:e2e -- data-export
```

Expected: 3 passed.

- [ ] **Step 3: Run companion checks**

```bash
pnpm --filter @tarmoto/companion lint
pnpm --filter @tarmoto/companion build
```

- [ ] **Step 4: Inspect the diff**

Run:

```bash
git log main..HEAD --oneline
git diff main..HEAD --stat
```

Sanity-check the file list against the plan's "File structure" section.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin claude/trusting-kalam-e4ab84
gh pr create --title "feat(backend): GDPR data export bundle (us-62)" --body "$(cat <<'EOF'
## Summary
- New endpoints `POST /account/data-export`, `GET /account/data-export/:id`, `GET /account/data-export/:id/download` assemble and serve a ZIP of all personal data the platform holds.
- Bundle includes profile (sanitized), contacts, preferences, privacy/notifications, rides + per-ride GPX, trips + per-day GPX, reviews, hazard reports, badges, challenges, commute routes, plus a README.
- Idempotency: max one active export per user; duplicate requests return the existing row.
- Download URLs are HMAC-signed and expire after 7 days; the file is streamed from local storage (placeholder for #277 object storage).
- Companion settings page polls until the bundle is ready and surfaces the download link inline.

## Scope notes
- Background processing is in-process (`setImmediate` after 202). When #276 ships a real queue, swap the worker dispatch.
- Storage is local-fs behind an `ExportStorage` interface. When #277 ships object storage, swap `LocalExportStorage` for an S3 implementation.
- Email delivery is deferred to #262; the URL is delivered via the GET endpoint, which the companion polls.
- Bike entity / structured notification + privacy entities don't exist yet — those files are emitted as empty stubs and called out in `README.txt`.

## Tests
- Unit: signed URL, local storage, sanitizer, GPX helpers, bundle assembler, service idempotency, processor lifecycle, controller responses.
- E2E: round-trip POST → poll → download → unzip + assert entry list, idempotency, signature rejection.

## Contract
- OpenAPI regenerated; new types appear in `packages/openapi/types.ts`.

## Closes
Closes #261

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Comment on the issue**

```bash
gh issue comment 261 --body "PR opened: <link from previous step>"
```

---

## Self-review checklist (run before handoff)

1. **Spec coverage** — every acceptance criterion has a task:
   - POST endpoint returning 202 + request ID → Task 10
   - Background worker → Task 9
   - All listed files in the ZIP → Task 7 (assembler) emits each
   - README.txt → Task 7
   - ZIP uploaded with signed URL expiring 7d → Tasks 4, 8
   - Email when ready → SCOPE NOTE: deferred to #262, GET endpoint serves as fallback per acceptance criteria
   - Anonymized road quality NOT included → Task 7 (no road_quality_segments query)
   - Rate limit (1 active per user) → Task 8 idempotency + Task 12 e2e
   - Tests → Tasks 3, 4, 5, 6, 7, 8, 9, 10, 12
   - OpenAPI updated → Task 13
2. **Placeholders** — none; every step has runnable commands or full code blocks.
3. **Type consistency** — `DataExportRequest`, `DataExportRequestDto`, `EXPORT_STORAGE`, `ExportStorage`, `signDownloadUrl`, `verifyDownloadSignature`, `BundleAssembler`, `DataExportService`, `DataExportProcessor` are spelled identically across tasks.
