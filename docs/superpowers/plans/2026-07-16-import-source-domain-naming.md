# {source}\_{domain} Import Naming Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the three bulk importers to a consistent `{source}_{domain}` scheme — `poi→osm_poi`, `fsq→fsq_poi`, `osm(road)→osm_road`, plus the road queue `osm.import→road.import` — with zero behavior change.

**Architecture:** A pure, wide rename across `packages/ingest`, `apps/ingest`, and `apps/backend` (+ docker/docs). Env vars, `registerAs` keys, the road config interface, and the road queue name change; the DB, OpenAPI, domain-level infra (`poi.import` queue, `PoiImportConfig`, `PoiImportService`, `TARMOTO_POI_DATABASE_*`, `TARMOTO_POI_UPLOAD_MAX_BYTES`), and all `source` values (`'osm'`/`'fsq'`) stay. No migration, no backward-compat.

**Tech Stack:** NestJS (`@nestjs/config` `registerAs`), BullMQ, TypeScript NodeNext ESM (`.js` import suffixes), pnpm workspaces, Vitest/Jest.

## Global Constraints

- **Exact rename mappings (verbatim — apply these and ONLY these):**
  - Env: `TARMOTO_POI_IMPORT_ENABLED`→`TARMOTO_OSM_POI_IMPORT_ENABLED`, `TARMOTO_POI_IMPORT_DIR`→`TARMOTO_OSM_POI_IMPORT_DIR`, `TARMOTO_POI_IMPORT_REGIONS`→`TARMOTO_OSM_POI_IMPORT_REGIONS`, `TARMOTO_POI_REFRESH_ENABLED`→`TARMOTO_OSM_POI_REFRESH_ENABLED`.
  - Env: `TARMOTO_FSQ_IMPORT_ENABLED`→`TARMOTO_FSQ_POI_IMPORT_ENABLED`, `TARMOTO_FSQ_IMPORT_DIR`→`TARMOTO_FSQ_POI_IMPORT_DIR`, `TARMOTO_FSQ_IMPORT_REGIONS`→`TARMOTO_FSQ_POI_IMPORT_REGIONS`, `TARMOTO_FSQ_REFRESH_ENABLED`→`TARMOTO_FSQ_POI_REFRESH_ENABLED`, `TARMOTO_FSQ_TOKEN`→`TARMOTO_FSQ_POI_TOKEN`.
  - Env: `TARMOTO_OSM_IMPORT_ENABLED`→`TARMOTO_OSM_ROAD_IMPORT_ENABLED`, `TARMOTO_OSM_IMPORT_BBOX`→`TARMOTO_OSM_ROAD_IMPORT_BBOX`, `TARMOTO_OSM_IMPORT_FILE`→`TARMOTO_OSM_ROAD_IMPORT_FILE`.
  - Config: `poiImportConfig`→`osmPoiImportConfig` (registerAs key `"poiImport"`→`"osmPoiImport"`); `fsqImportConfig`→`fsqPoiImportConfig` (key `"fsqImport"`→`"fsqPoiImport"`); `osmImportConfig`→`osmRoadImportConfig` (key `'osmImport'`→`'osmRoadImport'`).
  - Interface: `OsmImportConfig`→`RoadImportConfig`. **KEEP `PoiImportConfig`** (shared shape for both POI configs).
  - Queue: `QUEUE_NAMES.OSM_IMPORT` (`'osm.import'`)→`QUEUE_NAMES.ROAD_IMPORT` (`'road.import'`); `JOB_NAMES.OSM_IMPORT_RUN`→`JOB_NAMES.ROAD_IMPORT_RUN` (value `'run'` unchanged); the scheduler job-id string `'osm.import.run'`→`'road.import.run'`; the `queue-health` property `osmImport`→`roadImport`.
- **DO NOT rename** (domain-level / already-correct): `TARMOTO_POI_DATABASE_*`, `TARMOTO_POI_UPLOAD_MAX_BYTES`, the `poi.import` queue (`POI_IMPORT_QUEUE`), `PoiImportConfig`/`PoiImportService`/`PoiImportProcessor`/`PoiImportScheduler`, `@tarmoto/poi-db`, the `pois`/`road_segments` tables, `pois.source` values `'osm'`/`'fsq'`, `road_segments.quality_source` `'osm_quality_seed'`, the source-strategy classes `OsmPoiImportSource`/`FsqPoiImportSource`. `ALL_QUEUE_NAMES` stays **14**.
- **No behavior change**: existing tests must stay green (update the names they assert; do NOT change what they assert semantically). No new features.
- **NodeNext ESM**: keep `.js` suffixes on relative imports; if a file is renamed, update every importer's specifier.
- **Historical artifacts are OFF-LIMITS**: do NOT edit `docs/superpowers/**` (specs/plans record old names intentionally) or ADR _history_ — Task 4 handles operational docs + a forward-note only.
- **Per-task gate**: `pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/backend build` green; the touched `test`s green; `pnpm openapi:gen` → `git status --porcelain packages/openapi-client` EMPTY; and `rg` for that task's OLD tokens across code (excluding `docs/superpowers/**`, `**/dist/**`) returns ZERO.

---

### Task 1: POI imports — `poi→osm_poi` + `fsq→fsq_poi` (packages/ingest + apps/ingest)

**Files:**

- Modify: `packages/ingest/src/poi/refresh-config.ts` + `refresh-config.spec.ts` (env reads/labels for `TARMOTO_POI_IMPORT_*` + `TARMOTO_FSQ_*`)
- Modify: `packages/ingest/src/poi/regions.ts` + `regions.spec.ts` (the `parseRegions` env-name labels `TARMOTO_POI_IMPORT_REGIONS` / `TARMOTO_FSQ_IMPORT_REGIONS`)
- Modify: `apps/ingest/src/poi/poi-import.config.ts` + `poi-import.config.spec.ts` (the two `registerAs`, env reads; KEEP `PoiImportConfig` interface)
- Modify: `apps/ingest/src/poi/poi.module.ts` (imports + `forFeature(poiImportConfig)`/`forFeature(fsqImportConfig)` + `.KEY` injects)
- Modify: `apps/ingest/src/poi/poi-import.service.ts` + `poi-import.service.spec.ts` (`poiImportConfig` import + `.KEY` inject + doc comments)
- Modify: `apps/ingest/src/poi/poi-import.processor.ts` + `poi-import.processor.spec.ts` (config refs; the DB `source` literal `"osm"` in `LEGACY_REGION_SOURCE` STAYS)
- Modify: `apps/ingest/src/scripts/refresh-poi-extracts.ts` + `.spec.ts` (`TARMOTO_POI_REFRESH_ENABLED`, `TARMOTO_POI_IMPORT_DIR`)
- Modify: `apps/ingest/src/scripts/refresh-fsq-extracts.ts` + `.spec.ts` (`TARMOTO_FSQ_*` incl. `TARMOTO_FSQ_TOKEN`, `TARMOTO_FSQ_REFRESH_ENABLED`)
- Modify: `apps/ingest/src/scripts/import-pois.ts` (`TARMOTO_POI_IMPORT_*` + `TARMOTO_FSQ_*`)
- Modify: `apps/ingest/src/internal/poi-internal.service.ts` (any `fsqImportConfig`/`poiImportConfig` ref used by the enablement view)
- Check: `apps/ingest/test/poi-import.e2e-spec.ts` (uses `TARMOTO_POI_DATABASE_*` which STAYS — but grep for any `TARMOTO_POI_IMPORT_*` / `TARMOTO_FSQ_*` it sets and rename those)

**Interfaces:**

- Produces (later tasks depend on these NEW names): env vars `TARMOTO_OSM_POI_IMPORT_{ENABLED,DIR,REGIONS}`, `TARMOTO_OSM_POI_REFRESH_ENABLED`, `TARMOTO_FSQ_POI_IMPORT_{ENABLED,DIR,REGIONS}`, `TARMOTO_FSQ_POI_REFRESH_ENABLED`, `TARMOTO_FSQ_POI_TOKEN`; configs `osmPoiImportConfig` (key `"osmPoiImport"`) + `fsqPoiImportConfig` (key `"fsqPoiImport"`), both still typed `PoiImportConfig`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Rename the two POI configs in `poi-import.config.ts`.** `poiImportConfig`→`osmPoiImportConfig`, `registerAs("poiImport", …)`→`registerAs("osmPoiImport", …)`, its env reads `TARMOTO_POI_IMPORT_ENABLED/DIR/REGIONS`→`TARMOTO_OSM_POI_IMPORT_*`. `fsqImportConfig`→`fsqPoiImportConfig`, `registerAs("fsqImport", …)`→`registerAs("fsqPoiImport", …)`, env `TARMOTO_FSQ_IMPORT_*`→`TARMOTO_FSQ_POI_IMPORT_*`. Leave `interface PoiImportConfig` unchanged. Update the file's doc comments that name the old vars.

- [ ] **Step 2: Follow the config symbol through its importers.** In `poi.module.ts`, `poi-import.service.ts`, `poi-import.processor.ts`, `internal/poi-internal.service.ts`: rename every `poiImportConfig`→`osmPoiImportConfig` and `fsqImportConfig`→`fsqPoiImportConfig` identifier (imports, `.KEY`, `ConfigType<typeof …>`, doc comments). Do NOT touch `PoiImportService`/`PoiImportProcessor` class names or the `poi.import` queue.

- [ ] **Step 3: Rename env reads in the scripts + pure lib.** `refresh-poi-extracts.ts` (`TARMOTO_POI_REFRESH_ENABLED`, `TARMOTO_POI_IMPORT_DIR`), `refresh-fsq-extracts.ts` (`TARMOTO_FSQ_REFRESH_ENABLED`, `TARMOTO_FSQ_TOKEN`, `TARMOTO_FSQ_IMPORT_DIR`), `import-pois.ts`, `packages/ingest/src/poi/refresh-config.ts`, `regions.ts` — apply the env mappings from Global Constraints. In `regions.ts` the strings are the error-message _labels_ passed to `parseRegions` (`"TARMOTO_POI_IMPORT_REGIONS"` etc.) — rename those too.

- [ ] **Step 4: Update the specs to assert the new names.** In every `*.spec.ts` above, replace old env/config names with new ones (both the `vi.stubEnv`/`process.env` setters and any asserted error-message substrings). Behavior assertions stay identical.

- [ ] **Step 5: Build + test + straggler grep.**

```bash
pnpm --filter @tarmoto/ingest build && pnpm --filter @tarmoto/ingest test
# straggler check — MUST be empty (code only):
rg "TARMOTO_POI_IMPORT|TARMOTO_POI_REFRESH|TARMOTO_FSQ_IMPORT|TARMOTO_FSQ_REFRESH|TARMOTO_FSQ_TOKEN|poiImportConfig|fsqImportConfig|\"poiImport\"|\"fsqImport\"" packages/ingest/src apps/ingest/src apps/ingest/test
```

Expected: build+test green; grep prints nothing. (`TARMOTO_POI_DATABASE_*` legitimately remains — the pattern above excludes it.)

- [ ] **Step 6: Commit.**

```bash
git add packages/ingest apps/ingest
git commit -m "refactor(ingest): rename POI imports to osm_poi + fsq_poi"
```

---

### Task 2: Backend upload env reads + Docker + compose + .env.examples

**Files:**

- Modify: `apps/backend/src/modules/poi/poi-import-admin.service.ts` + `poi-import-admin.service.spec.ts` (the upload `extractDir()` reads `TARMOTO_POI_IMPORT_DIR` + `TARMOTO_FSQ_IMPORT_DIR`; **`TARMOTO_POI_UPLOAD_MAX_BYTES` STAYS**; the `OsmPoiImportSource`/`FsqPoiImportSource` class names STAY)
- Modify: `apps/backend/Dockerfile` (`ARG TARMOTO_POI_IMPORT_DIR` + `ARG TARMOTO_FSQ_IMPORT_DIR` + their `RUN` uses)
- Modify: `apps/ingest/Dockerfile` (`ARG TARMOTO_POI_IMPORT_DIR` + `ARG TARMOTO_FSQ_IMPORT_DIR` + `RUN`)
- Modify: `apps/backend/.env.example` (`TARMOTO_POI_IMPORT_DIR`, `TARMOTO_FSQ_IMPORT_DIR` entries)
- Modify: `apps/ingest/.env.example` (all the `TARMOTO_OSM_POI_*` / `TARMOTO_FSQ_POI_*` entries — this file documents the full set)
- Check + modify if present: `infra/docker/docker-compose.yml` (grep for `TARMOTO_POI_IMPORT`/`TARMOTO_FSQ_IMPORT`; `TARMOTO_POI_DATABASE_*` there STAYS)

**Interfaces:**

- Consumes from Task 1: the new env names (`TARMOTO_OSM_POI_IMPORT_DIR`, `TARMOTO_FSQ_POI_IMPORT_DIR`, …). The backend upload dir MUST match what `apps/ingest` reads.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Rename the upload-dir env reads in `poi-import-admin.service.ts`.** `TARMOTO_POI_IMPORT_DIR`→`TARMOTO_OSM_POI_IMPORT_DIR`, `TARMOTO_FSQ_IMPORT_DIR`→`TARMOTO_FSQ_POI_IMPORT_DIR` (in `extractDir()` + the 503 message text). Leave `TARMOTO_POI_UPLOAD_MAX_BYTES` and the source-strategy class usage untouched.

- [ ] **Step 2: Update the spec** (`poi-import-admin.service.spec.ts`) — the `fakeConfig()` keys + any asserted messages that name the two dirs.

- [ ] **Step 3: Rename the Docker `ARG`s + `RUN` refs** in both `apps/backend/Dockerfile` and `apps/ingest/Dockerfile` (the `TARMOTO_POI_IMPORT_DIR`/`TARMOTO_FSQ_IMPORT_DIR` ARG names + every shell reference; the `/data/poi-extracts` default value stays).

- [ ] **Step 4: Update `.env.example`s.** In `apps/backend/.env.example` rename the two dir vars. In `apps/ingest/.env.example` rename ALL the affected vars to the Task-1 names (`TARMOTO_OSM_POI_IMPORT_*`, `TARMOTO_OSM_POI_REFRESH_ENABLED`, `TARMOTO_FSQ_POI_IMPORT_*`, `TARMOTO_FSQ_POI_REFRESH_ENABLED`, `TARMOTO_FSQ_POI_TOKEN`), keeping the surrounding explanatory comments accurate.

- [ ] **Step 5: docker-compose check.** `rg "TARMOTO_POI_IMPORT|TARMOTO_FSQ_IMPORT" infra/docker/docker-compose.yml` — rename any hits (leave `TARMOTO_POI_DATABASE_*`).

- [ ] **Step 6: Build + test + straggler grep + openapi.**

```bash
pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend test poi-import-admin
pnpm openapi:gen && git status --porcelain packages/openapi-client   # MUST be empty
rg "TARMOTO_POI_IMPORT|TARMOTO_FSQ_IMPORT_(DIR|ENABLED|REGIONS)|TARMOTO_FSQ_REFRESH|TARMOTO_FSQ_TOKEN" apps/backend/src apps/backend/Dockerfile apps/ingest/Dockerfile apps/backend/.env.example apps/ingest/.env.example infra/docker/docker-compose.yml
```

Expected: green; openapi byte-identical; grep empty.

- [ ] **Step 7: Commit.**

```bash
git add apps/backend/src/modules/poi apps/backend/Dockerfile apps/ingest/Dockerfile apps/backend/.env.example apps/ingest/.env.example infra/docker/docker-compose.yml
git commit -m "refactor(cross): rename POI upload-dir envs to osm_poi/fsq_poi"
```

---

### Task 3: OSM road import `osm→osm_road` + queue `osm.import→road.import`

**Files:**

- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.config.ts` + `.spec.ts` (`OsmImportConfig`→`RoadImportConfig`, `osmImportConfig`→`osmRoadImportConfig`, `registerAs('osmImport'…)`→`registerAs('osmRoadImport'…)`, `TARMOTO_OSM_IMPORT_*`→`TARMOTO_OSM_ROAD_IMPORT_*`)
- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.service.ts` + `.spec.ts` (`osmImportConfig` import/`.KEY`/`ConfigType`; keep the `quality_source` value `'osm_quality_seed'`)
- Modify: `apps/backend/src/modules/roads/osm-import/osm-import.processor.ts` (`@Processor(QUEUE_NAMES.OSM_IMPORT)`→`ROAD_IMPORT`)
- Modify: `apps/backend/src/modules/roads/roads.module.ts` (`osmImportConfig` import + `forFeature`)
- Modify: `apps/backend/src/modules/roads/quality-conflation/quality-conflation.service.ts` (`osmImportConfig` import + `.KEY`) + `quality-conflation.config.ts` (grep for any `TARMOTO_OSM_*` reads → `TARMOTO_OSM_ROAD_*` if part of the road import; leave conflation-specific vars that are not the import namespace)
- Modify: `apps/backend/src/modules/jobs/jobs.constants.ts` (`OSM_IMPORT: 'osm.import'`→`ROAD_IMPORT: 'road.import'`; `OSM_IMPORT_RUN`→`ROAD_IMPORT_RUN`; the doc comment referencing `osm.import`)
- Modify: `apps/backend/src/modules/jobs/jobs.scheduler.ts` + `jobs.scheduler.spec.ts` (`@InjectQueue(QUEUE_NAMES.OSM_IMPORT)`, `JOB_NAMES.OSM_IMPORT_RUN`, the scheduler id string `'osm.import.run'`→`'road.import.run'`)
- Modify: `apps/backend/src/modules/jobs/queue-health.service.ts` (`@InjectQueue(QUEUE_NAMES.OSM_IMPORT)`, the property `osmImport`→`roadImport`, the `[QUEUE_NAMES.OSM_IMPORT]: this.osmImport` map entry)
- Note: the folder `roads/osm-import/` + file names STAY (the `roads/` parent already disambiguates the domain; only symbols/env/queue rename).

**Interfaces:**

- Consumes: nothing (independent subsystem).
- Produces: `QUEUE_NAMES.ROAD_IMPORT` (`'road.import'`), `JOB_NAMES.ROAD_IMPORT_RUN`, `osmRoadImportConfig`, `RoadImportConfig` — used only within this task's files.

- [ ] **Step 1: Rename the queue constants** in `jobs.constants.ts`: `OSM_IMPORT: 'osm.import'`→`ROAD_IMPORT: 'road.import'` and `OSM_IMPORT_RUN`→`ROAD_IMPORT_RUN` (keep value `'run'`); fix the neighboring doc comment. Confirm `ALL_QUEUE_NAMES` still derives 14 entries.

- [ ] **Step 2: Follow the queue constant** through `jobs.scheduler.ts`, `queue-health.service.ts`, `osm-import.processor.ts`: every `QUEUE_NAMES.OSM_IMPORT`→`QUEUE_NAMES.ROAD_IMPORT`, `JOB_NAMES.OSM_IMPORT_RUN`→`ROAD_IMPORT_RUN`, the `queue-health` property `osmImport`→`roadImport`, and the scheduler-id literal `'osm.import.run'`→`'road.import.run'`.

- [ ] **Step 3: Rename the road config** in `osm-import.config.ts`: `OsmImportConfig`→`RoadImportConfig`, `osmImportConfig`→`osmRoadImportConfig`, `registerAs('osmImport'…)`→`registerAs('osmRoadImport'…)`, env `TARMOTO_OSM_IMPORT_{ENABLED,BBOX,FILE}`→`TARMOTO_OSM_ROAD_IMPORT_*`.

- [ ] **Step 4: Follow the config symbol** through `osm-import.service.ts`, `roads.module.ts`, `quality-conflation.service.ts` (imports, `.KEY`, `ConfigType<typeof osmRoadImportConfig>`). Audit `quality-conflation.config.ts` for `TARMOTO_OSM_*` reads and rename any that belong to the osm-road import namespace.

- [ ] **Step 5: Update the specs** (`osm-import.config.spec.ts`, `osm-import.service.spec.ts`, `jobs.scheduler.spec.ts`) for the new names + the `'road.import.run'` id.

- [ ] **Step 6: Build + test + straggler grep.**

```bash
pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/backend test roads jobs
rg "TARMOTO_OSM_IMPORT|osmImportConfig|OsmImportConfig|'osmImport'|OSM_IMPORT\b|osm\.import" apps/backend/src
```

Expected: green; grep empty (the only remaining `osm` tokens are the DB `source`/`quality_source` value literals + the `roads/osm-import` folder path, neither matched above).

- [ ] **Step 7: Commit.**

```bash
git add apps/backend/src/modules/roads apps/backend/src/modules/jobs
git commit -m "refactor(backend): rename OSM road import to osm_road + road.import queue"
```

---

### Task 4: Operational docs + ops-enablement checklist

**Files:**

- Modify: `docs/process/runbook.md` (every `TARMOTO_POI_IMPORT_*`/`TARMOTO_FSQ_*`/`TARMOTO_OSM_IMPORT_*` + the `osm.import` queue + the ops-enablement var checklist)
- Modify: `docs/reference/data-sources-and-storage.md` (§8.3 + POI/road var references)
- Modify: `docs/reference/architecture.md` (the queue table entry `osm.import`→`road.import`; the import env var names)
- Modify: `apps/backend/src/modules/roads/osm-import/README.md` + `apps/backend/src/modules/roads/quality-conflation/README.md`
- Add a forward-note (NOT a rewrite) to `docs/decisions/0006-*.md` / `0007-*.md` if they name the renamed vars: a one-line "> Note (2026-07-16): these env vars were renamed to `{source}_{domain}` — see the naming-rework spec."
- OFF-LIMITS: `docs/superpowers/**`, ADR decision bodies (history stays).

**Interfaces:** consumes the final names from Tasks 1–3; produces nothing.

- [ ] **Step 1: Rename in the operational docs.** Apply the Global-Constraints env/queue mappings across `runbook.md`, `data-sources-and-storage.md`, `architecture.md`, and the two roads READMEs. Update the runbook's ops-enablement checklist so ops sets the NEW var names (`TARMOTO_OSM_POI_IMPORT_*`, `TARMOTO_FSQ_POI_IMPORT_*`, `TARMOTO_OSM_ROAD_IMPORT_*`, plus the unchanged `TARMOTO_INTERNAL_API_TOKEN`/`TARMOTO_INGEST_INTERNAL_URL`).

- [ ] **Step 2: ADR forward-notes.** `rg "TARMOTO_(POI|FSQ|OSM)_IMPORT|osm\.import" docs/decisions` — for each ADR hit, add the one-line forward-note at the top of the relevant section; do NOT rewrite the decision text.

- [ ] **Step 3: Final full-repo straggler sweep (code + operational docs).**

```bash
rg "TARMOTO_POI_IMPORT|TARMOTO_POI_REFRESH|TARMOTO_FSQ_IMPORT|TARMOTO_FSQ_REFRESH|TARMOTO_FSQ_TOKEN|TARMOTO_OSM_IMPORT|'osm\.import'|\"osm\.import\"|osmImportConfig|OsmImportConfig|poiImportConfig|fsqImportConfig" \
  --glob '!docs/superpowers/**' --glob '!**/dist/**' --glob '!docs/decisions/**'
```

Expected: empty (or only the intentional ADR forward-notes that quote the old name in the "renamed from" note). Investigate any other hit.

- [ ] **Step 4: Commit.**

```bash
git add docs apps/backend/src/modules/roads
git commit -m "docs(cross): rename import env vars + road queue to {source}_{domain}"
```

---

## Self-Review notes (author)

- **Spec coverage:** every spec rename-map row → Task 1 (POI), Task 3 (road+queue); "stays" list → Global Constraints; cross-app lockstep → Task 2; docs/ops → Task 4. ✅
- **Type consistency:** `PoiImportConfig` deliberately unchanged (shared shape); `RoadImportConfig` is the only interface rename; config keys `osmPoiImport`/`fsqPoiImport`/`osmRoadImport` used identically across steps. ✅
- **No-placeholder:** every step names exact tokens + files + commands. The one investigate-branch (`quality-conflation.config.ts` `TARMOTO_OSM_*`) is a deliberate audit step, not a placeholder. ✅
