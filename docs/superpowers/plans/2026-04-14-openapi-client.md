# OpenAPI Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a typed API client from the NestJS backend's OpenAPI spec, using `openapi-typescript` for types and `openapi-fetch` for the client, shared via `packages/openapi`.

**Architecture:** Backend exports the OpenAPI spec via a build-time script (no running server needed). `packages/openapi` holds the spec, generates TypeScript types, and exports a configured `openapi-fetch` client. The companion app replaces its hand-written Axios API client with the typed `openapi-fetch` client. Mobile app can import the same types/client later.

**Tech Stack:** `openapi-typescript` (types from spec), `openapi-fetch` (typed fetch client), `js-yaml` (YAML handling), NestJS Swagger plugin

**Closes:** GetTarmoto/tarmoto#80

---

## File Map

### Backend changes (`apps/backend/`)
- Create: `nest-cli.openapi.json` — NestJS build config with Swagger plugin for spec export
- Create: `src/scripts/export-openapi.ts` — script to bootstrap app, generate spec, write YAML
- Create: `src/config/swagger.config.ts` — extracted Swagger DocumentBuilder config (shared between main.ts and export script)
- Modify: `src/main.ts` — use shared swagger config
- Modify: `package.json` — add `openapi:export` script

### New package (`packages/openapi/`)
- Create: `package.json`
- Create: `scripts/generate.sh` — pipeline: export spec from backend → generate types
- Create: `scripts/generate-postman.js` — convert spec to Postman collection + environment
- Create: `openapi.yaml` — generated spec (committed to git for CI/consumers)
- Create: `types.ts` — generated TypeScript types (committed)
- Create: `client.ts` — pre-configured `openapi-fetch` client with auth interceptor
- Create: `index.ts` — barrel export
- Create: `postman/` — generated Postman files

### Companion changes (`apps/companion/`)
- Modify: `package.json` — add `@tarmoto/openapi` dependency, remove `axios`
- Modify: `src/lib/api.ts` — replace Axios client with `openapi-fetch` client from `@tarmoto/openapi`

### Root changes
- Modify: `package.json` — add `generate:api` script

---

## Task 1: Backend — Extract Swagger Config + Export Script

**Files:**
- Create: `apps/backend/src/config/swagger.config.ts`
- Create: `apps/backend/nest-cli.openapi.json`
- Create: `apps/backend/src/scripts/export-openapi.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/package.json`

- [ ] **Step 1: Create shared swagger config**

Extract the DocumentBuilder from main.ts into a reusable function at `apps/backend/src/config/swagger.config.ts`:

```ts
import { DocumentBuilder } from '@nestjs/swagger';

export function createSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Tarmoto API')
    .setDescription('Know the road before you ride it')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
}
```

- [ ] **Step 2: Update main.ts to use shared config**

In `apps/backend/src/main.ts`, replace the inline DocumentBuilder block with:

```ts
import { createSwaggerConfig } from './config/swagger.config.js';
```

And change the swagger setup to:
```ts
if (!isProd) {
  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup('api/docs', app, document);
}
```

Remove the `DocumentBuilder` import (keep `SwaggerModule`).

- [ ] **Step 3: Create nest-cli.openapi.json**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "classValidatorShim": false,
          "introspectComments": true,
          "dtoFileNameSuffix": [".dto.ts"]
        }
      }
    ]
  }
}
```

- [ ] **Step 4: Create export-openapi.ts script**

Create `apps/backend/src/scripts/export-openapi.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

// Provide placeholder env vars so the app can bootstrap without a full environment
process.env.OPENAPI_EXPORT = '1';
process.env.TARMOTO_DB_HOST ??= 'localhost';
process.env.TARMOTO_DB_PORT ??= '5432';
process.env.TARMOTO_DB_NAME ??= 'placeholder';
process.env.TARMOTO_DB_USER ??= 'placeholder';
process.env.TARMOTO_DB_PASS ??= 'placeholder';
process.env.TARMOTO_JWT_SECRET ??= 'openapi-export-placeholder';

async function exportOpenApi() {
  const { AppModule } = await import('../app.module.js');
  const { createSwaggerConfig } = await import('../config/swagger.config.js');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  const outputPath = path.resolve(
    __dirname,
    '../../../../../packages/openapi/openapi.yaml',
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(document, { lineWidth: 120 }), 'utf8');
  console.log(`OpenAPI spec written to ${outputPath}`);

  await app.close();
  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error('OpenAPI export failed:', err);
  process.exit(1);
});
```

Check what env var names the backend uses for DB config — read the database module or config to get the exact variable names. Adjust the placeholder env vars accordingly.

- [ ] **Step 5: Add js-yaml dependency and export script to backend package.json**

```bash
cd apps/backend && pnpm add js-yaml && pnpm add -D @types/js-yaml
```

Add to `apps/backend/package.json` scripts:
```
"openapi:export": "nest build --config nest-cli.openapi.json && node dist/src/scripts/export-openapi.js"
```

- [ ] **Step 6: Test the export**

```bash
cd apps/backend && pnpm openapi:export
```

Expected: `OpenAPI spec written to .../packages/openapi/openapi.yaml`. Check the file exists and has content.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/
git commit -m "feat(backend): add OpenAPI spec export script

Extracts Swagger config to shared module. Adds nest-cli.openapi.json
with Swagger plugin for DTO introspection. Export script writes
openapi.yaml to packages/openapi/ without needing a running server."
```

---

## Task 2: Create packages/openapi

**Files:**
- Create: `packages/openapi/package.json`
- Create: `packages/openapi/scripts/generate.sh`
- Create: `packages/openapi/scripts/generate-postman.js`
- Create: `packages/openapi/client.ts`
- Create: `packages/openapi/index.ts`
- Commit: `openapi.yaml` (generated in Task 1)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@tarmoto/openapi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./client": "./client.ts",
    "./types": "./types.ts"
  },
  "scripts": {
    "generate": "bash scripts/generate.sh",
    "generate:types": "openapi-typescript openapi.yaml -o types.ts",
    "postman": "node scripts/generate-postman.js"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0",
    "openapi-typescript": "^7.0.0"
  },
  "devDependencies": {
    "js-yaml": "^4.1.1"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /path/to/tarmoto-openapi && pnpm install
```

- [ ] **Step 3: Generate TypeScript types from the spec**

```bash
cd packages/openapi && pnpm generate:types
```

Expected: `types.ts` generated with all path types, component schemas, etc.

- [ ] **Step 4: Create the generate.sh pipeline script**

Create `packages/openapi/scripts/generate.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../../../apps/backend"

echo "==> Exporting OpenAPI spec from backend..."
(cd "$BACKEND_DIR" && pnpm openapi:export)

echo "==> Generating TypeScript types..."
cd "$SCRIPT_DIR/.."
pnpm generate:types

echo "==> Done!"
```

```bash
chmod +x packages/openapi/scripts/generate.sh
```

- [ ] **Step 5: Create the openapi-fetch client**

Create `packages/openapi/client.ts`:

```ts
import createClient from "openapi-fetch";
import type { paths } from "./types.js";

export function createApiClient(options: {
  baseUrl: string;
  getToken?: () => string | null;
}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
  });

  // Add auth header to every request
  client.use({
    async onRequest({ request }) {
      const token = options.getToken?.();
      if (token) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      return request;
    },
  });

  return client;
}

export type { paths } from "./types.js";
export type ApiClient = ReturnType<typeof createApiClient>;
```

- [ ] **Step 6: Create barrel export**

Create `packages/openapi/index.ts`:

```ts
export { createApiClient, type ApiClient, type paths } from "./client.js";
```

- [ ] **Step 7: Create Postman generation script**

Create `packages/openapi/scripts/generate-postman.js` — adapted from the nexcue pattern. Read the nexcue version at `/Users/akadlec/Development/GetNexcue/nexcue/packages/openapi/scripts/generate-postman.js` and adapt:
- Change "Nexcue" → "Tarmoto" in collection name, environment name
- Change `baseUrl` default to `http://localhost:3000/api/v1`
- Change output filenames to `tarmoto-api.postman_collection.json` and `tarmoto-local.postman_environment.json`
- Keep all the helper functions (buildUrl, buildQuery, buildBody, resolveExample)

Create the `packages/openapi/postman/` directory.

Run: `cd packages/openapi && pnpm postman`

Expected: Two files generated in `packages/openapi/postman/`.

- [ ] **Step 8: Commit**

```bash
git add packages/openapi/
git commit -m "feat: add packages/openapi with typed client and Postman export

openapi-fetch client with auth middleware.
TypeScript types generated from openapi.yaml via openapi-typescript.
Postman collection + environment auto-generated from spec."
```

---

## Task 3: Integrate into Companion App

**Files:**
- Modify: `apps/companion/package.json`
- Rewrite: `apps/companion/src/lib/api.ts`
- Modify: `apps/companion/src/lib/types.ts` (optional — may keep or replace with openapi types)

- [ ] **Step 1: Add @tarmoto/openapi dependency, remove axios**

```bash
cd apps/companion
pnpm add @tarmoto/openapi@workspace:*
pnpm remove axios
```

- [ ] **Step 2: Rewrite the API client**

Rewrite `apps/companion/src/lib/api.ts` to use `openapi-fetch`:

```ts
import { createApiClient, type ApiClient } from "@tarmoto/openapi/client";
import { useAuthStore } from "@/stores/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

export const api: ApiClient = createApiClient({
  baseUrl: API_BASE,
  getToken: () => useAuthStore.getState().accessToken,
});
```

That's it — the entire 130-line Axios file becomes ~8 lines. All the hand-written endpoint objects (`tripsApi`, `roadsApi`, `ridesApi`, etc.) are replaced by the typed `api` client. Callers use:

```ts
// Before (Axios):
const { data } = await tripsApi.list({ page: 1 });

// After (openapi-fetch):
const { data } = await api.GET("/api/v1/trips", { params: { query: { page: 1 } } });
```

- [ ] **Step 3: Update auth register call**

The register call in `apps/companion/src/app/(auth)/register/page.tsx` uses `authApi.register()`. Update it to use the openapi-fetch client:

```ts
import { api } from "@/lib/api";

// In handleSubmit:
const { data, error } = await api.POST("/api/v1/auth/register", {
  body: { email, password, display_name: displayName },
});
if (error) throw new Error(error.message ?? "Registration failed");
```

- [ ] **Step 4: Update pages that import from old API**

Search for all imports of `tripsApi`, `roadsApi`, `ridesApi`, `communityApi`, `accountApi` across the companion app. Update each to use `api.GET(...)`, `api.POST(...)` etc. with the typed paths.

Most pages just have placeholder data or empty states — the changes should be straightforward. Key files to check:
- `src/app/(dashboard)/trips/page.tsx` — uses `tripsApi.list()`
- `src/app/(dashboard)/rides/page.tsx` — uses `ridesApi.list()`
- `src/app/(dashboard)/settings/bikes/page.tsx` — uses `accountApi.getBikes()`

For pages that just have skeleton/placeholder content without real API calls, remove the import.

- [ ] **Step 5: Remove old types that are now in the spec**

The hand-written types in `apps/companion/src/lib/types.ts` can now be imported from `@tarmoto/openapi/types` where they match the spec. However, some types (like `QualityTier`, `SurfaceType`) are used throughout the app and may not exactly match the spec shape. For now, keep `types.ts` as-is — it can be migrated incrementally. Just add a comment at the top noting that canonical types come from `@tarmoto/openapi`.

- [ ] **Step 6: Verify build**

```bash
cd apps/companion && pnpm build
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/companion/
git commit -m "feat(companion): replace Axios with openapi-fetch typed client

Remove hand-written API endpoint objects. All API calls now use
the typed openapi-fetch client from @tarmoto/openapi.
Types are fully inferred from the OpenAPI spec."
```

---

## Task 4: Root Scripts + Final Verification

**Files:**
- Modify: root `package.json`

- [ ] **Step 1: Add generate:api script to root**

Add to root `package.json` scripts:
```
"generate:api": "pnpm --filter @tarmoto/openapi generate"
```

- [ ] **Step 2: Verify the full pipeline**

```bash
pnpm generate:api
```

Expected: Backend builds, spec exported, types regenerated.

- [ ] **Step 3: Verify companion build**

```bash
pnpm --filter @tarmoto/companion build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add generate:api root script for OpenAPI pipeline"
```
