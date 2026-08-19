# Route planner — live road-snapped routing (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single-day trip planner produce a real, road-snapped route that updates live as the rider places/drags/edits waypoints, with point placement via a right-click/long-press menu and a map that never yanks the view.

**Architecture:** A self-hosted **Valhalla** (Docker) serves real road routing. The backend gains a stateless `POST /routing/route` (Valhalla multi-via + PostGIS road-quality enrichment) used for the live preview, and a `PUT /trips/:id/route` that re-routes from waypoints and persists the day. The frontend replaces synthetic client-side geometry with debounced calls to `/routing/route`, swaps tap-to-drop for a context menu, and stops auto-fitting the map during edits.

**Tech Stack:** NestJS 11 + TypeORM + PostGIS (backend), Next.js + MapLibre GL + Zustand (companion), **Valhalla** (`ghcr.io/gis-ops/docker-valhalla/valhalla` Docker), Vitest (companion) / Jest (backend).

> **Engine note:** the self-hosted engine is **Valhalla** (chosen over OSRM for per-request dynamic costing, which makes the later curvy phase a request-time knob — no graph rebuild). The `RoutingProvider` interface abstracts it; only Tasks 1–2 are engine-specific, the rest is unchanged.

## Global Constraints

- Node 24+, pnpm workspaces. TypeScript strict mode everywhere.
- Backend serves **metric only** (km, metres, deg C, km/h); clients convert for display.
- App-owned env vars use the `TARMOTO_` prefix. Routing engine URL is `TARMOTO_VALHALLA_BASE_URL` (Valhalla `/route` JSON API; default `http://localhost:8002`). NOTE: commit _type_ must be from the repo commitlint enum (feat/fix/chore/docs/refactor/test/...) — `infra` is a valid _scope_, not a type; use `chore(infra): …`, not `infra(...): …`.
- Domain enums (surface types, waypoint types) live in `@tarmoto/shared`.
- Backend entities in `apps/backend/src/entities/`; feature modules in `apps/backend/src/modules/`.
- Conventional commits, scope required. Valid scopes: `backend`, `companion`, `infra`, `docs`, `openapi`, `cross`, etc. Commit header ≤ 100 chars; commit-msg footer (`Co-Authored-By`) must have a leading blank line.
- When backend API behaviour changes, regenerate OpenAPI + the client (`pnpm openapi:gen`) in the same change.
- Keep DTOs, OpenAPI output, and the companion's generated client aligned.

---

## File structure (created / modified)

**Infra**

- Create: `infra/valhalla/README.md` — runbook (the gis-ops image self-builds tiles on first start).
- Modify: `infra/docker/docker-compose.yml` — add `valhalla` service.
- Modify: `.gitignore` — ignore `infra/valhalla/custom_files/`.

**Backend**

- Modify: `apps/backend/src/modules/commute/routing-provider.interface.ts` — add `route()` to the interface + `RouteResult` type.
- Create: `apps/backend/src/modules/commute/providers/valhalla.provider.ts` — implement the full `RoutingProvider` (`route()` + `getAlternatives()` + `version`) against Valhalla; bound as `ROUTING_PROVIDER` (replaces `OsrmProvider`).
- Create: `apps/backend/src/modules/routing/route-enrichment.service.ts` — `RouteEnrichmentService.aggregate(geometry)` (extracted from the generator).
- Modify: `apps/backend/src/modules/trips/trip-generator.service.ts` — delegate enrichment to `RouteEnrichmentService`.
- Create: `apps/backend/src/modules/routing/routing.module.ts`
- Create: `apps/backend/src/modules/routing/routing.controller.ts` — `POST /routing/route`.
- Create: `apps/backend/src/modules/routing/routing.service.ts` — orchestrates provider + enrichment.
- Create: `apps/backend/src/modules/routing/dto/route.dto.ts` — request/response DTOs.
- Modify: `apps/backend/src/modules/trips/trips.controller.ts` — add `PUT /:tripId/route`.
- Modify: `apps/backend/src/modules/trips/trips.service.ts` — `saveManualRoute(userId, tripId, dto)`.
- Create: `apps/backend/src/modules/trips/dto/save-route.dto.ts`.
- Modify: `apps/backend/src/app.module.ts` — register `RoutingModule`.
- Tests alongside each (`*.spec.ts`).

**Companion (frontend)**

- Modify: `apps/companion/src/lib/api.ts` — `routingApi.route()`, `tripsApi.saveRoute()`.
- Create: `apps/companion/src/lib/planner-context-menu.ts` — pure `buildPlacementMenu(state)`.
- Create: `apps/companion/src/hooks/usePlannerRouting.ts` — debounced live-routing hook.
- Modify: `apps/companion/src/stores/trip.ts` — server-geometry actions; drop synthetic rebuild.
- Modify: `apps/companion/src/components/TripPlannerMap.tsx` — context-menu placement; no auto-fit on edit; render store geometry.
- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx` — hide Generate; Save; live stats; "Fit route".
- Delete: `apps/companion/src/lib/trip-planner-builder.ts` (synthetic geometry) — and remove references.
- Tests alongside (`*.test.ts(x)`).

**Docs**

- Modify: `docs/process/companion-testing-scenarios.md` — manual planner scenarios.

---

## Task 1: Self-hosted Valhalla (Docker) + runbook

**Files:**

- Create: `infra/valhalla/README.md`
- Modify: `infra/docker/docker-compose.yml`
- Modify: `.gitignore`

**Interfaces:**

- Produces: a reachable Valhalla at `http://localhost:8002` answering `POST /route` (JSON). Backend consumes via `TARMOTO_VALHALLA_BASE_URL=http://localhost:8002`.

No automated test (it provisions infra). The gis-ops Valhalla image **self-builds tiles on first container start** from `tile_urls`, so there's no build script — the first `docker compose up valhalla` downloads the extract and builds tiles into the `custom_files` volume (slow, one-time), then serves. Verification is a documented manual `curl` the human runs.

- [ ] **Step 1: Add the Valhalla service to the compose stack**

In `infra/docker/docker-compose.yml`, add a service (match the file's existing top-level `services:` indentation/style):

```yaml
valhalla:
  image: ghcr.io/gis-ops/docker-valhalla/valhalla:latest
  ports:
    - "8002:8002"
  volumes:
    - ../valhalla/custom_files:/custom_files
  environment:
    # First start downloads this extract + builds tiles into the volume;
    # later starts reuse the built tiles.
    tile_urls: https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf
    use_tiles_ignore_pbf: "True"
    build_elevation: "False"
    build_admins: "True"
    build_time_zones: "False"
    server_threads: "2"
  restart: unless-stopped
```

- [ ] **Step 2: Ignore the build artifacts**

Append to `.gitignore`:

```
# Self-hosted Valhalla tiles + extract (large; built on first container start)
infra/valhalla/custom_files/
```

- [ ] **Step 3: Write the runbook**

Create `infra/valhalla/README.md`:

```markdown
# Self-hosted Valhalla (route planner routing engine)

The route planner routes against a local Valhalla (OSS) instead of a public
demo. Chosen for per-request dynamic costing (motorcycle / curvy later, no
rebuild). Czech-Republic extract by default.

## Build + run (first start builds tiles — slow, one-time)

    docker compose -f infra/docker/docker-compose.yml up valhalla
    # first run downloads the extract + builds tiles into infra/valhalla/custom_files
    # (git-ignored); subsequent runs reuse them.

For a larger region, change `tile_urls` in the compose service (e.g.
`https://download.geofabrik.de/europe/dach-latest.osm.pbf`) and delete
`infra/valhalla/custom_files` to force a rebuild.

## Point the backend at it

    # apps/backend/.env
    TARMOTO_VALHALLA_BASE_URL=http://localhost:8002

## Verify

    curl -s http://localhost:8002/route \
      -H 'Content-Type: application/json' \
      --data '{"locations":[{"lat":50.08,"lon":14.42},{"lat":50.10,"lon":14.50}],"costing":"auto","directions_options":{"units":"kilometers"}}'
    # -> {"trip":{"legs":[{"shape":"...","summary":{...}}],"summary":{...},"status":0}}

## Coolify (production)

Run the same image as a service with a persistent volume mounted at
`/custom_files` and the same `tile_urls` env. First boot builds tiles into the
volume; set `TARMOTO_VALHALLA_BASE_URL` on the backend to the service URL.
```

- [ ] **Step 4: Validate + commit**

Validate the compose YAML parses (`python3 -c "import yaml; yaml.safe_load(open('infra/docker/docker-compose.yml'))"`, or `docker compose -f infra/docker/docker-compose.yml config` if Docker is present — do NOT start containers / build tiles here; that's the human's step).

```bash
git add infra/valhalla/README.md infra/docker/docker-compose.yml .gitignore
git commit -m "chore(infra): self-hosted Valhalla routing service for the planner"
```

---

## Task 2: Valhalla routing provider (route + getAlternatives)

**Files:**

- Modify: `apps/backend/src/modules/commute/routing-provider.interface.ts` (add `RouteResult` + `route()`)
- Create: `apps/backend/src/modules/commute/providers/valhalla.provider.ts`
- Create: `apps/backend/src/modules/commute/providers/valhalla.provider.spec.ts`
- Modify: the commute module that binds `ROUTING_PROVIDER` — bind `ValhallaProvider` instead of `OsrmProvider`. Find it: `grep -rn "ROUTING_PROVIDER" apps/backend/src/modules/commute`. Leave `OsrmProvider` in place (unused fallback impl).

**Interfaces:**

- Produces: `class ValhallaProvider implements RoutingProvider` with:
  - `version = 'valhalla-v1'`
  - `route(waypoints, options?) => Promise<RouteResult | null>` — `RouteResult = { distance_km; duration_min; geometry: {lat;lng}[] }`; `null` on engine error / no trip.
  - `getAlternatives(originLat, originLng, destLat, destLng, maxAlternatives, options?) => Promise<RouteAlternative[]>` — the same contract `OsrmProvider` had (the trip generator + commute consume it via `ROUTING_PROVIDER`).
- Consumes: `ConfigService` (`TARMOTO_VALHALLA_BASE_URL`, default `http://localhost:8002`), `RoutingOptions` (`avoidHighways`, `avoidTolls`, `includePrimary`).

### Valhalla API shape (reference)

- `POST {base}/route`, JSON body:
  ```jsonc
  {
    "locations": [{ "lat": 50.08, "lon": 14.42 }, ...],   // lon, not lng
    "costing": "auto",
    "directions_options": { "units": "kilometers" },
    "costing_options": { "auto": { "use_highways": 0, "use_tolls": 0 } } // only when avoiding
    // "alternates": N   // top-level, only for getAlternatives
  }
  ```
- Response: `{ "trip": { "legs": [{ "shape": "<encoded polyline precision 6>", "summary": { "length": <km>, "time": <s> } }], "summary": { "length", "time" } }, "alternates"?: [{ "trip": {...} }] }`. Non-200 / `{error}` = failure.
- Geometry is an **encoded polyline at precision 1e6** (not 1e5). Distance = `trip.summary.length` (km). Duration = `trip.summary.time` seconds → minutes.

- [ ] **Step 1: Add `RouteResult` + `route()` to the interface**

In `routing-provider.interface.ts` add:

```ts
/** A single road-snapped route through an ordered list of waypoints. */
export interface RouteResult {
  distance_km: number;
  duration_min: number;
  geometry: Array<{ lat: number; lng: number }>;
}
```

and inside `interface RoutingProvider { ... }`:

```ts
  /**
   * Road-snapped route through `waypoints` in order. Returns `null` when the
   * engine cannot route (e.g. an isolated point). Reuses `RoutingOptions`.
   */
  route(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
  ): Promise<RouteResult | null>;
```

- [ ] **Step 2: Write the failing test**

Create `valhalla.provider.spec.ts`:

```ts
import { ConfigService } from "@nestjs/config";
import { ValhallaProvider } from "./valhalla.provider.js";

function provider(): ValhallaProvider {
  const config = {
    get: (k: string) =>
      k === "TARMOTO_VALHALLA_BASE_URL" ? "http://valhalla.test" : undefined,
  } as unknown as ConfigService;
  return new ValhallaProvider(config);
}

// Encode helper so the test owns its polyline-6 fixture.
function encodePolyline6(points: Array<[number, number]>): string {
  let lastLat = 0,
    lastLng = 0,
    out = "";
  const enc = (v: number) => {
    let sgn = v << 1;
    if (v < 0) sgn = ~sgn;
    let s = "";
    while (sgn >= 0x20) {
      s += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
      sgn >>>= 5;
    }
    s += String.fromCharCode(sgn + 63);
    return s;
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e6),
      ln = Math.round(lng * 1e6);
    out += enc(la - lastLat) + enc(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

describe("ValhallaProvider.route", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("POSTs locations (lon) + decodes the leg shape", async () => {
    const shape = encodePolyline6([
      [50.08, 14.42],
      [50.1, 14.5],
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [{ shape, summary: { length: 88.9, time: 7440 } }],
          summary: { length: 88.9, time: 7440 },
        },
      }),
    });

    const result = await provider().route([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://valhalla.test/route");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.locations).toEqual([
      { lat: 50.08, lon: 14.42 },
      { lat: 50.1, lon: 14.5 },
    ]);
    expect(body.costing).toBe("auto");
    expect(result!.distance_km).toBe(88.9);
    expect(result!.duration_min).toBe(124);
    expect(result!.geometry[0].lat).toBeCloseTo(50.08, 5);
    expect(result!.geometry.at(-1)!.lng).toBeCloseTo(14.5, 5);
  });

  it("sets use_highways=0 when avoidHighways is set", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [
            {
              shape: encodePolyline6([
                [0, 0],
                [1, 1],
              ]),
              summary: { length: 1, time: 60 },
            },
          ],
          summary: { length: 1, time: 60 },
        },
      }),
    });
    await provider().route(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      { avoidHighways: true },
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.costing_options.auto.use_highways).toBe(0);
  });

  it("returns null when Valhalla cannot route", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "No path" }),
    });
    expect(
      await provider().route([
        { lat: 0, lng: 0 },
        { lat: 9, lng: 9 },
      ]),
    ).toBeNull();
  });
});

describe("ValhallaProvider.getAlternatives", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("returns primary + alternates when includePrimary", async () => {
    const shape = encodePolyline6([
      [0, 0],
      [1, 1],
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        trip: {
          legs: [{ shape, summary: { length: 10, time: 600 } }],
          summary: { length: 10, time: 600 },
        },
        alternates: [
          {
            trip: {
              legs: [{ shape, summary: { length: 12, time: 700 } }],
              summary: { length: 12, time: 700 },
            },
          },
        ],
      }),
    });
    const alts = await provider().getAlternatives(0, 0, 1, 1, 3, {
      includePrimary: true,
    });
    expect(alts.map((a) => a.distance_km)).toEqual([10, 12]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.alternates).toBe(2); // maxAlternatives - 1 extras
  });
});
```

- [ ] **Step 3: Run the test (expect FAIL)**

Run: `cd apps/backend && pnpm exec jest valhalla.provider -v`
Expected: FAIL — cannot find `valhalla.provider`.

- [ ] **Step 4: Implement `ValhallaProvider`**

Create `valhalla.provider.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  RouteAlternative,
  RouteResult,
  RoutingOptions,
  RoutingProvider,
} from "../routing-provider.interface.js";

interface ValhallaLeg {
  shape: string;
  summary: { length: number; time: number };
}
interface ValhallaTrip {
  legs: ValhallaLeg[];
  summary: { length: number; time: number };
}
interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
}

/** Decode a Google-encoded polyline at precision 1e6 (Valhalla default). */
function decodePolyline6(encoded: string): Array<{ lat: number; lng: number }> {
  const out: Array<{ lat: number; lng: number }> = [];
  let i = 0,
    lat = 0,
    lng = 0;
  const next = () => {
    let shift = 0,
      result = 0,
      b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}

@Injectable()
export class ValhallaProvider implements RoutingProvider {
  private readonly logger = new Logger(ValhallaProvider.name);
  private readonly baseUrl: string;
  readonly version = "valhalla-v1";

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>("TARMOTO_VALHALLA_BASE_URL") ??
      "http://localhost:8002";
  }

  private body(
    locations: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
    alternates?: number,
  ): string {
    const costing: Record<string, number> = {};
    if (options?.avoidHighways) costing.use_highways = 0;
    if (options?.avoidTolls) costing.use_tolls = 0;
    return JSON.stringify({
      locations: locations.map((w) => ({ lat: w.lat, lon: w.lng })),
      costing: "auto",
      directions_options: { units: "kilometers" },
      ...(Object.keys(costing).length
        ? { costing_options: { auto: costing } }
        : {}),
      ...(alternates && alternates > 0 ? { alternates } : {}),
    });
  }

  private async post(body: string): Promise<ValhallaResponse | null> {
    const res = await fetch(`${this.baseUrl}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      this.logger.error(
        `Valhalla route failed: ${res.status} ${res.statusText}`,
      );
      return null;
    }
    return (await res.json()) as ValhallaResponse;
  }

  private tripToResult(trip: ValhallaTrip): RouteResult {
    const geometry: Array<{ lat: number; lng: number }> = [];
    trip.legs.forEach((leg, idx) => {
      const pts = decodePolyline6(leg.shape);
      // Drop the duplicate join vertex shared with the previous leg.
      geometry.push(...(idx === 0 ? pts : pts.slice(1)));
    });
    return {
      distance_km: Math.round(trip.summary.length * 100) / 100,
      duration_min: Math.round(trip.summary.time / 60),
      geometry,
    };
  }

  async route(
    waypoints: ReadonlyArray<{ lat: number; lng: number }>,
    options?: RoutingOptions,
  ): Promise<RouteResult | null> {
    if (waypoints.length < 2) return null;
    const data = await this.post(this.body(waypoints, options));
    if (!data?.trip?.legs?.length) return null;
    return this.tripToResult(data.trip);
  }

  async getAlternatives(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    maxAlternatives: number,
    options?: RoutingOptions,
  ): Promise<RouteAlternative[]> {
    const includePrimary = options?.includePrimary === true;
    const extras = includePrimary
      ? Math.max(0, maxAlternatives - 1)
      : maxAlternatives;
    const data = await this.post(
      this.body(
        [
          { lat: originLat, lng: originLng },
          { lat: destLat, lng: destLng },
        ],
        options,
        extras,
      ),
    );
    if (!data?.trip) return [];
    const trips: ValhallaTrip[] = [
      ...(includePrimary ? [data.trip] : []),
      ...(data.alternates ?? []).map((a) => a.trip),
    ];
    return trips.slice(0, maxAlternatives).map((t) => this.tripToResult(t));
  }
}
```

(`RouteResult` and `RouteAlternative` share the same field shape, so `tripToResult` serves both.)

- [ ] **Step 5: Bind `ValhallaProvider` as `ROUTING_PROVIDER`**

In the commute module that provides `ROUTING_PROVIDER`, change the provider class (`useClass: OsrmProvider` or the factory) to `ValhallaProvider` and add `ValhallaProvider` to the providers list. Leave `OsrmProvider` in place. The generator + commute now route via Valhalla through the unchanged interface; their unit tests mock the provider, so they are unaffected. The `version` bump to `valhalla-v1` invalidates the commute primary-route polyline cache (#361) — those polylines re-resolve on next read, which is the version field's intended behaviour.

- [ ] **Step 6: Run tests (expect PASS) + build**

Run: `cd apps/backend && pnpm exec jest valhalla.provider commute trip-generator -v && pnpm build`
Expected: PASS + clean build (existing commute/generator specs still green — they mock the provider).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/commute
git commit -m "feat(backend): Valhalla routing provider (multi-via route + alternatives)"
```

---

## Task 3: Extract `RouteEnrichmentService`

**Files:**

- Create: `apps/backend/src/modules/routing/route-enrichment.service.ts`
- Create: `apps/backend/src/modules/routing/route-enrichment.service.spec.ts`
- Modify: `apps/backend/src/modules/trips/trip-generator.service.ts` (delegate)

**Interfaces:**

- Produces: `RouteEnrichmentService.aggregate(geometry: ReadonlyArray<{lat;lng}>) => Promise<RouteMetrics>` where `RouteMetrics` is the existing shape: `{ avgQuality: number|null; curvinessScore: number|null; scenicScore: number|null; elevationGain: number; elevationLoss: number; hazardCount: number; surfaceMixMetres: Record<string,number> }`. Export `RouteMetrics` from this file.
- Consumes: `DataSource` (TypeORM), and the PostGIS query body currently in `TripGeneratorService.aggregateRouteMetrics` (read it at `apps/backend/src/modules/trips/trip-generator.service.ts:562` before extracting; also move the constants `ROAD_BUFFER_M`, `HAZARD_BUFFER_M`, `SCENIC_OVERLAP_BUFFER_KM` and the `geometryToWkt` helper it uses, or re-export them).

- [ ] **Step 1: Write the failing test (mock DataSource.query)**

Create `route-enrichment.service.spec.ts`:

```ts
import { RouteEnrichmentService } from "./route-enrichment.service.js";
import type { DataSource } from "typeorm";

describe("RouteEnrichmentService.aggregate", () => {
  it("maps the four PostGIS rows into RouteMetrics", async () => {
    const query = jest
      .fn()
      // quality row
      .mockResolvedValueOnce([
        {
          avg_quality: 4.0,
          avg_curviness: 6.1,
          elevation_span: 540,
          total_length_m: 88900,
        },
      ])
      // surface rows
      .mockResolvedValueOnce([
        { surface_type: "asphalt", length_m: 82000 },
        { surface_type: "gravel", length_m: 6900 },
      ])
      // hazard rows
      .mockResolvedValueOnce([{ count: 0 }])
      // scenic rows
      .mockResolvedValueOnce([{ avg_scenic: 3.2, zone_count: 2 }]);
    const ds = { query } as unknown as DataSource;

    const m = await new RouteEnrichmentService(ds).aggregate([
      { lat: 50.08, lng: 14.42 },
      { lat: 50.1, lng: 14.5 },
    ]);

    expect(m.avgQuality).toBe(4.0);
    expect(m.curvinessScore).toBe(6.1);
    expect(m.elevationGain).toBe(540);
    expect(m.surfaceMixMetres).toEqual({ asphalt: 82000, gravel: 6900 });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module not found)**

Run: `cd apps/backend && pnpm exec jest route-enrichment -v`
Expected: FAIL — cannot find `route-enrichment.service`.

- [ ] **Step 3: Create the service by moving the method body**

Create `route-enrichment.service.ts`. Move the `RouteMetrics` interface, the buffer constants, the `geometryToWkt` helper, and the **entire body** of `TripGeneratorService.aggregateRouteMetrics` (read it first at `trip-generator.service.ts:562`) into:

```ts
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

export interface RouteMetrics {
  avgQuality: number | null;
  curvinessScore: number | null;
  scenicScore: number | null;
  elevationGain: number;
  elevationLoss: number;
  hazardCount: number;
  surfaceMixMetres: Record<string, number>;
}

// (move ROAD_BUFFER_M / HAZARD_BUFFER_M / SCENIC_OVERLAP_BUFFER_KM and
//  geometryToWkt here, exactly as they exist today.)

@Injectable()
export class RouteEnrichmentService {
  constructor(private readonly dataSource: DataSource) {}

  async aggregate(
    geometry: ReadonlyArray<{ lat: number; lng: number }>,
  ): Promise<RouteMetrics> {
    // ...the exact body currently in TripGeneratorService.aggregateRouteMetrics,
    //    with `this.dataSource.query(...)` calls unchanged...
  }
}
```

- [ ] **Step 4: Make the generator delegate**

In `trip-generator.service.ts`: inject `RouteEnrichmentService`, delete the moved constants/helper/`RouteMetrics`/`aggregateRouteMetrics` body, import `RouteMetrics` + the service, and replace every `this.aggregateRouteMetrics(geom)` call with `this.enrichment.aggregate(geom)`. Add `RouteEnrichmentService` to the providers of the module that declares `TripGeneratorService` (and ensure `DataSource` is available there — it already injects `DataSource`).

- [ ] **Step 5: Run the tests (expect PASS, no generator regressions)**

Run: `cd apps/backend && pnpm exec jest route-enrichment trip-generator -v`
Expected: PASS (both the new test and the existing generator specs).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/routing/route-enrichment.service.ts \
        apps/backend/src/modules/routing/route-enrichment.service.spec.ts \
        apps/backend/src/modules/trips/trip-generator.service.ts \
        apps/backend/src/modules/trips/trips.module.ts
git commit -m "refactor(backend): extract RouteEnrichmentService from the trip generator"
```

---

## Task 4: `POST /routing/route` (stateless live preview)

**Files:**

- Create: `apps/backend/src/modules/routing/dto/route.dto.ts`
- Create: `apps/backend/src/modules/routing/routing.service.ts`
- Create: `apps/backend/src/modules/routing/routing.controller.ts`
- Create: `apps/backend/src/modules/routing/routing.module.ts`
- Modify: `apps/backend/src/app.module.ts` (register `RoutingModule`)
- Test: `apps/backend/src/modules/routing/routing.service.spec.ts`

**Interfaces:**

- Produces: `RoutingService.route(dto: RouteRequestDto) => Promise<RouteResponseDto>`. `RouteResponseDto = { geometry: {lat;lng}[]; distance_km; duration_min; avg_quality: number|null; curviness_score: number|null; elevation_gain_m; surface_mix: Record<string,number> }`.
- Consumes: `ROUTING_PROVIDER` (`route()` from Task 2), `RouteEnrichmentService` (Task 3). `RouteRequestDto = { waypoints: {lat;lng}[]; options?: { avoid_highways?; avoid_tolls?; avoid_unpaved?; surfaces?: string[] } }`. Auth via the existing `AuthGuard`.

- [ ] **Step 1: DTOs**

Create `dto/route.dto.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class LatLngDto {
  @ApiProperty() @IsNumber() lat!: number;
  @ApiProperty() @IsNumber() lng!: number;
}

export class RouteOptionsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_highways?: boolean;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_tolls?: boolean;
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  avoid_unpaved?: boolean;
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  surfaces?: string[];
}

export class RouteRequestDto {
  @ApiProperty({ type: [LatLngDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  waypoints!: LatLngDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}

export class RouteResponseDto {
  @ApiProperty({ type: [LatLngDto] }) geometry!: LatLngDto[];
  @ApiProperty() distance_km!: number;
  @ApiProperty() duration_min!: number;
  @ApiProperty({ nullable: true }) avg_quality!: number | null;
  @ApiProperty({ nullable: true }) curviness_score!: number | null;
  @ApiProperty() elevation_gain_m!: number;
  @ApiProperty({ type: "object", additionalProperties: { type: "number" } })
  surface_mix!: Record<string, number>;
}
```

- [ ] **Step 2: Write the failing service test**

Create `routing.service.spec.ts`:

```ts
import { BadGatewayException } from "@nestjs/common";
import { RoutingService } from "./routing.service.js";

describe("RoutingService.route", () => {
  const provider = {
    route: jest.fn(),
    getAlternatives: jest.fn(),
    version: "valhalla-v1",
  };
  const enrichment = { aggregate: jest.fn() };
  const service = new RoutingService(provider as never, enrichment as never);

  beforeEach(() => {
    provider.route.mockReset();
    enrichment.aggregate.mockReset();
  });

  it("routes + enriches and shapes the response", async () => {
    provider.route.mockResolvedValueOnce({
      distance_km: 88.9,
      duration_min: 124,
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
    });
    enrichment.aggregate.mockResolvedValueOnce({
      avgQuality: 4.0,
      curvinessScore: 6.1,
      scenicScore: 3.2,
      elevationGain: 540,
      elevationLoss: 540,
      hazardCount: 0,
      surfaceMixMetres: { asphalt: 82000 },
    });

    const res = await service.route({
      waypoints: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      options: { avoid_highways: true },
    });

    expect(provider.route).toHaveBeenCalledWith(
      [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      { avoidHighways: true, avoidTolls: undefined },
    );
    expect(res).toEqual({
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
      distance_km: 88.9,
      duration_min: 124,
      avg_quality: 4.0,
      curviness_score: 6.1,
      elevation_gain_m: 540,
      surface_mix: { asphalt: 82000 },
    });
  });

  it("throws 502 when the engine cannot route", async () => {
    provider.route.mockResolvedValueOnce(null);
    await expect(
      service.route({
        waypoints: [
          { lat: 0, lng: 0 },
          { lat: 9, lng: 9 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(enrichment.aggregate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test (expect FAIL)**

Run: `cd apps/backend && pnpm exec jest routing.service -v` → FAIL (no module).

- [ ] **Step 4: Implement the service**

Create `routing.service.ts`:

```ts
import { BadGatewayException, Inject, Injectable } from "@nestjs/common";
import {
  ROUTING_PROVIDER,
  type RoutingProvider,
} from "../commute/routing-provider.interface.js";
import { RouteEnrichmentService } from "./route-enrichment.service.js";
import type { RouteRequestDto, RouteResponseDto } from "./dto/route.dto.js";

@Injectable()
export class RoutingService {
  constructor(
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider,
    private readonly enrichment: RouteEnrichmentService,
  ) {}

  async route(dto: RouteRequestDto): Promise<RouteResponseDto> {
    const route = await this.provider.route(
      dto.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
      {
        avoidHighways: dto.options?.avoid_highways,
        avoidTolls: dto.options?.avoid_tolls,
      },
    );
    if (!route) {
      throw new BadGatewayException("No road route between these points");
    }
    const m = await this.enrichment.aggregate(route.geometry);
    return {
      geometry: route.geometry,
      distance_km: route.distance_km,
      duration_min: route.duration_min,
      avg_quality: m.avgQuality,
      curviness_score: m.curvinessScore,
      elevation_gain_m: m.elevationGain,
      surface_mix: m.surfaceMixMetres,
    };
  }
}
```

- [ ] **Step 5: Controller + module**

Create `routing.controller.ts`:

```ts
import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard.js";
import { RoutingService } from "./routing.service.js";
import { RouteRequestDto, RouteResponseDto } from "./dto/route.dto.js";

@ApiTags("routing")
@Controller("routing")
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Post("route")
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Road-snapped route through waypoints (live planner preview)",
  })
  @ApiResponse({ status: 201, type: RouteResponseDto })
  @ApiResponse({
    status: 502,
    description: "Routing engine could not route these points",
  })
  async route(@Body() dto: RouteRequestDto): Promise<RouteResponseDto> {
    return this.routingService.route(dto);
  }
}
```

Create `routing.module.ts` (import `CommuteModule` so `ROUTING_PROVIDER` is available — verify it re-exports the token, as the trips module already consumes it):

```ts
import { Module } from "@nestjs/common";
import { CommuteModule } from "../commute/index.js";
import { RoutingController } from "./routing.controller.js";
import { RoutingService } from "./routing.service.js";
import { RouteEnrichmentService } from "./route-enrichment.service.js";

@Module({
  imports: [CommuteModule],
  controllers: [RoutingController],
  providers: [RoutingService, RouteEnrichmentService],
  exports: [RouteEnrichmentService],
})
export class RoutingModule {}
```

Register `RoutingModule` in `app.module.ts` imports. (Have the trips module import `RoutingModule` and use its exported `RouteEnrichmentService` instead of declaring its own, to keep one instance.)

- [ ] **Step 6: Run the test (expect PASS) + build**

Run: `cd apps/backend && pnpm exec jest routing.service -v && pnpm build`
Expected: PASS + clean build.

- [ ] **Step 7: Regenerate OpenAPI + client, commit**

```bash
pnpm openapi:gen
git add apps/backend/src/modules/routing apps/backend/src/app.module.ts \
        packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): POST /routing/route — stateless road-snapped live routing"
```

---

## Task 5: `PUT /trips/:tripId/route` (persist the manual route)

**Files:**

- Create: `apps/backend/src/modules/trips/dto/save-route.dto.ts`
- Modify: `apps/backend/src/modules/trips/trips.service.ts` (`saveManualRoute`)
- Modify: `apps/backend/src/modules/trips/trips.controller.ts` (endpoint)
- Test: extend `apps/backend/src/modules/trips/trips.service.spec.ts`

**Interfaces:**

- Produces: `TripsService.saveManualRoute(userId, tripId, dto) => Promise<TripDetailDto>`. `SaveRouteDto = { waypoints: { lat; lng; name?: string|null; type: 'start'|'via'|'end' }[]; options?: RouteOptionsDto }`.
- Consumes: `ROUTING_PROVIDER.route()` (Task 2), `RouteEnrichmentService.aggregate()` (Task 3), existing `getDetail` for ownership + the response. Writes day 1 to `TripDay` + `TripWaypoint`.

- [ ] **Step 1: DTO**

Create `save-route.dto.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { LatLngDto, RouteOptionsDto } from "../../routing/dto/route.dto.js";

export class SaveRouteWaypointDto extends LatLngDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiProperty({ enum: ["start", "via", "end"] })
  @IsIn(["start", "via", "end"])
  type!: "start" | "via" | "end";
}

export class SaveRouteDto {
  @ApiProperty({ type: [SaveRouteWaypointDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => SaveRouteWaypointDto)
  waypoints!: SaveRouteWaypointDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}
```

- [ ] **Step 2: Write the failing service test**

Add to `trips.service.spec.ts` (mirror the existing mock setup; add `ROUTING_PROVIDER` + `RouteEnrichmentService` to the test providers, and a member row so the post-save `getDetail` resolves):

```ts
describe("saveManualRoute", () => {
  it("re-routes from waypoints, persists day 1 + waypoints, returns detail", async () => {
    routingProvider.route.mockResolvedValueOnce({
      distance_km: 88.9,
      duration_min: 124,
      geometry: [
        { lat: 50.08, lng: 14.42 },
        { lat: 50.1, lng: 14.5 },
      ],
    });
    enrichment.aggregate.mockResolvedValueOnce({
      avgQuality: 4,
      curvinessScore: 6,
      scenicScore: 3,
      elevationGain: 540,
      elevationLoss: 540,
      hazardCount: 0,
      surfaceMixMetres: {},
    });
    mockGetDetailReturns(makeOwnedTrip()); // post-save reload (member = owner)

    const result = await service.saveManualRoute(OWNER_ID, TRIP_ID, {
      waypoints: [
        { lat: 50.08, lng: 14.42, type: "start" },
        { lat: 50.1, lng: 14.5, type: "end" },
      ],
    });

    expect(routingProvider.route).toHaveBeenCalled();
    expect(result.id).toBe(TRIP_ID);
  });

  it("rejects a non-member (404)", async () => {
    // membership lookup returns null -> NotFoundException (mirror getDetail gating)
    await expect(
      service.saveManualRoute(OTHER_ID, TRIP_ID, {
        waypoints: [
          { lat: 0, lng: 0, type: "start" },
          { lat: 1, lng: 1, type: "end" },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 3: Run the test (expect FAIL)**

Run: `cd apps/backend && pnpm exec jest trips.service -t saveManualRoute -v` → FAIL.

- [ ] **Step 4: Implement `saveManualRoute`**

Inject `@Inject(ROUTING_PROVIDER) routingProvider` + `RouteEnrichmentService enrichment` into `TripsService` (and add `RoutingModule` to the trips module imports so they resolve). Implement (model the persistence on the existing generator persistence + `getDetail` membership gate — read `getDetail` at `trips.service.ts:968` first):

```ts
async saveManualRoute(
  userId: string,
  tripId: string,
  dto: SaveRouteDto,
): Promise<TripDetailDto> {
  // 1. membership gate (reuse the same pattern as getDetail: inner-join trip_members)
  const member = await this.memberRepo.findOne({ where: { trip_id: tripId, user_id: userId } });
  if (!member) throw new NotFoundException('Trip not found');

  // 2. road-snap + enrich, server-side (never trust client geometry)
  const route = await this.routingProvider.route(
    dto.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
    { avoidHighways: dto.options?.avoid_highways, avoidTolls: dto.options?.avoid_tolls },
  );
  if (!route) throw new BadGatewayException('No road route between these points');
  const m = await this.enrichment.aggregate(route.geometry);

  // 3. persist day 1 + waypoints in a transaction (replace existing day 1):
  //    - upsert trip_days (day_number=1) with route_geom = LineString(route.geometry),
  //      distance_km, avg_quality, curviness_score, elevation_gain/loss, estimated_time
  //      (derive estimated_time interval from duration_min)
  //    - delete existing trip_waypoints for that day, insert dto.waypoints in order
  //      (sequence 0..n, location = Point(lng,lat), waypoint_type, name)
  //    Use the same WKT/Point helpers the generator uses.

  return this.getDetail(userId, tripId);
}
```

(Write the transaction body using the same `dataSource.transaction` + raw `ST_GeomFromText`/`ST_MakePoint` inserts the generator already uses for `trip_days`/`trip_waypoints`; read the generator's persistence pass for the exact column SQL.)

- [ ] **Step 5: Controller endpoint**

In `trips.controller.ts` add (the controller is class-guarded by `AuthGuard`):

```ts
  @Put(':tripId/route')
  @ApiOperation({ summary: 'Persist a manually-built route (server re-routes from waypoints)' })
  @ApiResponse({ status: 200, type: TripDetailDto })
  async saveRoute(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SaveRouteDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.saveManualRoute(req.user!.userId, tripId, dto);
  }
```

- [ ] **Step 6: Run tests (expect PASS) + build + OpenAPI**

Run: `cd apps/backend && pnpm exec jest trips.service -v && pnpm build`
Expected: PASS + clean. Then `pnpm openapi:gen`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/trips packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): PUT /trips/:id/route — persist a manual road-snapped route"
```

---

## Task 6: Companion API client methods

**Files:**

- Modify: `apps/companion/src/lib/api.ts`
- Test: `apps/companion/src/lib/api.test.ts` (only if the file has existing tests; otherwise covered via the hook test in Task 8)

**Interfaces:**

- Produces: `routingApi.route(body: RouteRequestBody) => Promise<{ data: RouteResponse }>` and `tripsApi.saveRoute(tripId, body: SaveRouteBody) => Promise<{ data: TripDetailResponse }>`, typed off the regenerated OpenAPI client. `RouteRequestBody = { waypoints: {lat;lng}[]; options?: {...} }`.

- [ ] **Step 1: Add the methods**

Following the existing generated-client pattern in `api.ts` (e.g. `tripsApi.get` using `openApiData(api.POST(...))`), add:

```ts
export type RouteRequestBody = JsonRequest<"/api/v1/routing/route", "post">;
export type RouteResponse = JsonResponse<"/api/v1/routing/route", "post", 201>;

export const routingApi = {
  route: (body: RouteRequestBody, init?: RequestInit) =>
    openApiData<RouteResponse>(
      api.POST("/api/v1/routing/route", { body, ...(init ? { ...init } : {}) }),
    ),
};
```

and on `tripsApi` add:

```ts
  saveRoute: (tripId: string, body: SaveRouteBody) =>
    openApiData<TripDetailResponse>(
      api.PUT('/api/v1/trips/{tripId}/route', {
        params: { path: { tripId } },
        body,
      }),
    ),
```

with `export type SaveRouteBody = JsonRequest<'/api/v1/trips/{tripId}/route', 'put'>;`.

(If `api.POST` doesn't accept an `AbortSignal` via `init`, pass `{ signal }` through the openapi-fetch options object it does accept — verify against an existing call that uses `{ signal }`, e.g. `roadsApi.getSegmentDetail`.)

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit` → clean.

```bash
git add apps/companion/src/lib/api.ts
git commit -m "feat(companion): api client for /routing/route and PUT /trips/:id/route"
```

---

## Task 7: Context-menu placement logic (pure)

**Files:**

- Create: `apps/companion/src/lib/planner-context-menu.ts`
- Test: `apps/companion/src/lib/planner-context-menu.test.ts`

**Interfaces:**

- Produces: `buildPlacementMenu(state: { hasStart: boolean; hasEnd: boolean }) => PlacementAction[]` where `PlacementAction = { id: 'set-start'|'set-end'|'add-via'|'set-new-start'|'set-new-end'; label: string }`. Pure, no map deps.

- [ ] **Step 1: Write the failing test**

```ts
import { buildPlacementMenu } from "./planner-context-menu";

describe("buildPlacementMenu", () => {
  it("offers only Set start when there is no start", () => {
    expect(
      buildPlacementMenu({ hasStart: false, hasEnd: false }).map((a) => a.id),
    ).toEqual(["set-start"]);
  });
  it("offers Set end + Add via when start exists but no end", () => {
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: false }).map((a) => a.id),
    ).toEqual(["set-end", "add-via"]);
  });
  it("offers Add via + replace start/end when both exist", () => {
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: true }).map((a) => a.id),
    ).toEqual(["add-via", "set-new-start", "set-new-end"]);
  });
});
```

- [ ] **Step 2: Run (expect FAIL)** — `pnpm --filter @tarmoto/companion exec vitest run planner-context-menu` → FAIL.

- [ ] **Step 3: Implement**

```ts
export type PlacementActionId =
  "set-start" | "set-end" | "add-via" | "set-new-start" | "set-new-end";
export interface PlacementAction {
  id: PlacementActionId;
  label: string;
}

export function buildPlacementMenu(state: {
  hasStart: boolean;
  hasEnd: boolean;
}): PlacementAction[] {
  if (!state.hasStart) return [{ id: "set-start", label: "Set start here" }];
  if (!state.hasEnd)
    return [
      { id: "set-end", label: "Set end here" },
      { id: "add-via", label: "Add via here" },
    ];
  return [
    { id: "add-via", label: "Add via here" },
    { id: "set-new-start", label: "Set as new start" },
    { id: "set-new-end", label: "Set as new end" },
  ];
}
```

- [ ] **Step 4: Run (expect PASS) + commit**

```bash
git add apps/companion/src/lib/planner-context-menu.ts apps/companion/src/lib/planner-context-menu.test.ts
git commit -m "feat(companion): state-aware planner context-menu option builder"
```

---

## Task 8: Live-routing hook (debounce + cancel)

**Files:**

- Create: `apps/companion/src/hooks/usePlannerRouting.ts`
- Test: `apps/companion/src/hooks/usePlannerRouting.test.ts`

**Interfaces:**

- Produces: `usePlannerRouting(waypoints, options, onResult, onError) => { routing: boolean }`. On `waypoints`/`options` change it debounces ~300 ms, calls `routingApi.route` with an AbortController, ignores stale responses (monotonic id), calls `onResult(RouteResponse)` on success and `onError(message)` on failure. With < 2 waypoints it does nothing (and clears `routing`).
- Consumes: `routingApi.route` (Task 6).

- [ ] **Step 1: Write the failing test** (fake timers + mocked `routingApi`)

```ts
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePlannerRouting } from "./usePlannerRouting";
import { routingApi } from "@/lib/api";

vi.mock("@/lib/api", () => ({ routingApi: { route: vi.fn() } }));
const routeMock = vi.mocked(routingApi.route);

const wp = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ lat: 50 + i, lng: 14 + i }));

describe("usePlannerRouting", () => {
  beforeEach(() => {
    routeMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing with fewer than 2 waypoints", () => {
    renderHook(() => usePlannerRouting(wp(1), {}, vi.fn(), vi.fn()));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("debounces then calls onResult with the routed response", async () => {
    routeMock.mockResolvedValueOnce({
      data: { geometry: [], distance_km: 5 },
    } as never);
    const onResult = vi.fn();
    renderHook(() => usePlannerRouting(wp(2), {}, onResult, vi.fn()));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ geometry: [], distance_km: 5 }),
    );
    expect(routeMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run (expect FAIL)** — `pnpm --filter @tarmoto/companion exec vitest run usePlannerRouting` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { useEffect, useRef, useState } from "react";
import {
  routingApi,
  type RouteRequestBody,
  type RouteResponse,
} from "@/lib/api";

export function usePlannerRouting(
  waypoints: ReadonlyArray<{ lat: number; lng: number }>,
  options: RouteRequestBody["options"],
  onResult: (r: RouteResponse) => void,
  onError: (message: string) => void,
): { routing: boolean } {
  const [routing, setRouting] = useState(false);
  const reqIdRef = useRef(0);
  // Snapshot the latest callbacks so the effect doesn't re-run on identity churn.
  const cbRef = useRef({ onResult, onError });
  cbRef.current = { onResult, onError };

  useEffect(() => {
    if (waypoints.length < 2) {
      setRouting(false);
      return;
    }
    const controller = new AbortController();
    const reqId = ++reqIdRef.current;
    const handle = setTimeout(() => {
      setRouting(true);
      routingApi
        .route(
          { waypoints: [...waypoints], options },
          { signal: controller.signal },
        )
        .then(({ data }) => {
          if (reqId === reqIdRef.current) cbRef.current.onResult(data);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || reqId !== reqIdRef.current) return;
          cbRef.current.onError(
            err instanceof Error ? err.message : "Could not compute the route",
          );
        })
        .finally(() => {
          if (reqId === reqIdRef.current) setRouting(false);
        });
    }, 300);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [waypoints, options]);

  return { routing };
}
```

- [ ] **Step 4: Run (expect PASS) + commit**

```bash
git add apps/companion/src/hooks/usePlannerRouting.ts apps/companion/src/hooks/usePlannerRouting.test.ts
git commit -m "feat(companion): debounced live-routing hook with stale-cancel"
```

---

## Task 9: Store — server geometry + waypoint actions

**Files:**

- Modify: `apps/companion/src/stores/trip.ts`
- Test: `apps/companion/src/stores/trip.test.ts` (create if absent; otherwise extend)

**Interfaces:**

- Produces (new/changed store actions on `useTripStore`):
  - `applyRouteResult(result: RouteResponse): void` — writes geometry + stats into the active day (replaces synthetic rebuild).
  - `setWaypointType(waypointId, type): void`, `removeWaypoint(waypointId): void`, `placeWaypoint({ lat, lng }, action): void` (action = a `PlacementActionId`).
  - `routingWaypoints(): {lat;lng}[]` selector — ordered start→vias→end coords (drives the hook).
- Consumes: `RouteResponse` (Task 6), `PlacementActionId` (Task 7).

- [ ] **Step 1: Write the failing test** (covers placement order + applyRouteResult)

```ts
import { useTripStore } from "./trip";

beforeEach(() => useTripStore.getState().resetForTest?.()); // add a tiny test reset

it("places start then end then via in routing order", () => {
  const s = useTripStore.getState();
  s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
  s.placeWaypoint({ lat: 3, lng: 3 }, "set-end");
  s.placeWaypoint({ lat: 2, lng: 2 }, "add-via");
  expect(useTripStore.getState().routingWaypoints()).toEqual([
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 },
    { lat: 3, lng: 3 },
  ]);
});

it("applyRouteResult writes geometry + distance to the active day", () => {
  const s = useTripStore.getState();
  s.placeWaypoint({ lat: 1, lng: 1 }, "set-start");
  s.placeWaypoint({ lat: 2, lng: 2 }, "set-end");
  s.applyRouteResult({
    geometry: [
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
    ],
    distance_km: 12.3,
    duration_min: 20,
    avg_quality: 4,
    curviness_score: 5,
    elevation_gain_m: 100,
    surface_mix: {},
  } as never);
  const day = useTripStore.getState().activeTrip!.days[0];
  expect(day.distanceKm).toBe(12.3);
  expect(day.routeGeometry?.coordinates.length).toBe(2);
});
```

- [ ] **Step 2: Run (expect FAIL)** — `pnpm --filter @tarmoto/companion exec vitest run stores/trip` → FAIL.

- [ ] **Step 3: Implement the actions**

Read `trip.ts` first (esp. `rebuildPlannerDay`, `appendPlannerWaypoint`, `moveWaypoint`). Then:

- Add `placeWaypoint(coords, action)`: maps the `PlacementActionId` to a mutation — `set-start`/`set-new-start` replace the start waypoint; `set-end`/`set-new-end` replace the end; `add-via` inserts a via before the end (or appends if no end). Each pushes an undo snapshot.
- Add `setWaypointType` / `removeWaypoint`.
- Add `routingWaypoints()` selector returning start→vias→end coords (filter to routing types, in sequence).
- Add `applyRouteResult(result)`: set `activeTrip.days[active].routeGeometry = { type:'LineString', coordinates: result.geometry.map(p=>[p.lng,p.lat]) }`, `distanceKm`, `durationMinutes`, `avgQuality`, etc. **Remove** the call to the synthetic `rebuildPlannerDay` geometry build — geometry now only comes from `applyRouteResult`. (Keep `moveWaypoint`/`reorderWaypoints` mutating positions, but they no longer synth-build geometry; the live hook recomputes it.)
- Add a minimal `resetForTest()` (or expose `setState`) used only by tests.

- [ ] **Step 4: Run (expect PASS) + commit**

```bash
git add apps/companion/src/stores/trip.ts apps/companion/src/stores/trip.test.ts
git commit -m "feat(companion): trip store actions for server-driven route geometry"
```

---

## Task 10: Wire the map — context menu, drag re-route, no auto-fit

**Files:**

- Modify: `apps/companion/src/components/TripPlannerMap.tsx`
- (No new unit test — MapLibre gestures are covered by manual/e2e; the pure menu/store/hook logic is already tested in Tasks 7–9.)

**Interfaces:**

- Consumes: `buildPlacementMenu` (Task 7), the store actions (Task 9). Produces: a working map where right-click/long-press opens the menu, placement/drag re-route live, and editing never re-fits the view.

- [ ] **Step 1: Replace tap-to-drop with the context menu**

Read `TripPlannerMap.tsx:421` (`handleMapClick`) first. Then:

- Change the left-click handler so it **no longer adds a waypoint** — it only closes the context menu / deselects.
- Add `contextmenu` (desktop) and a long-press detector (touch: `touchstart` + ~500 ms timer cancelled by `touchmove`/`touchend`) that:
  1. snaps the point via the existing `snapPointerToRoad()`,
  2. reads `{ hasStart, hasEnd }` from the store,
  3. renders a small menu (a positioned `<ul>` overlay or a MapLibre marker-anchored popover) from `buildPlacementMenu(...)`,
  4. on an item click, calls `placeWaypoint(snappedCoords, action.id)` and closes the menu.

- [ ] **Step 2: Keep drag → live re-route**

The existing drag handler (`finishDrag` → `onMoveWaypoint`) stays, but it now just updates the waypoint position in the store (Task 9 `moveWaypoint`); the live-routing hook (mounted in the page, Task 11) recomputes the geometry. Remove any direct synthetic geometry rebuild from the drag path.

- [ ] **Step 3: Remove auto-fit on edit (the zoom-yank fix)**

Find the effect that calls `map.fitBounds`/`flyTo` on waypoint/route change and **remove the waypoint-change dependency** so it runs only once on initial mount of an existing trip. Add an exposed `fitRoute()` on the map handle (imperative) for an explicit "Fit route" button (Task 11).

- [ ] **Step 4: Render the route from store geometry**

Ensure the route line source reads `activeTrip.days[active].routeGeometry` (set by `applyRouteResult`) — it already renders `routeGeometry`; just confirm it updates when the store geometry changes and shows nothing when there's no geometry yet.

- [ ] **Step 5: Manual verify + commit**

Manual: right-click → "Set start"; right-click → "Set end" → a road-following line appears; drag a point → line re-routes; zoom in, place a point → zoom is preserved.

```bash
git add apps/companion/src/components/TripPlannerMap.tsx
git commit -m "feat(companion): context-menu waypoint placement + stable map in the planner"
```

---

## Task 11: Wire the planner page — live hook, Save, Fit, hide Generate

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx`

**Interfaces:**

- Consumes: `usePlannerRouting` (Task 8), store `routingWaypoints`/`applyRouteResult`/parameters (Task 9), `tripsApi.saveRoute` (Task 6), the map handle `fitRoute()` (Task 10).

- [ ] **Step 1: Mount the live-routing hook**

In `RoadMapPageInner`/`TripPlannerPage`, derive `const waypoints = useTripStore(s => s.routingWaypoints())` and the routing `options` from the parameters panel, then:

```tsx
const applyRouteResult = useTripStore((s) => s.applyRouteResult);
const { routing } = usePlannerRouting(
  waypoints,
  routeOptions,
  applyRouteResult,
  (msg) => toast.error(msg),
);
```

Show a subtle "routing…" indicator when `routing` is true.

- [ ] **Step 2: Replace Generate with Save**

Hide/remove the **Generate** button + its 3-option preview cards. Add a **Save** button, disabled unless there's a valid routed start→end (`waypoints.length >= 2 && activeTrip.days[active].routeGeometry`):

```tsx
const onSave = async () => {
  const wps = useTripStore.getState().saveWaypoints(); // [{lat,lng,name,type}]
  const { data } = await tripsApi.saveRoute(tripId, {
    waypoints: wps,
    options: routeOptions,
  });
  useTripStore.getState().setActiveTrip(tripFromDetail(data));
  toast.success("Route saved");
};
```

(Add a tiny `saveWaypoints()` store selector returning the ordered typed waypoints — start/via/end — for the save payload.)

- [ ] **Step 3: Add "Fit route"**

Add a small "Fit route" control that calls the map handle's `fitRoute()` (Task 10) — the only thing that re-frames the map besides initial load.

- [ ] **Step 4: Live stats from real data**

Point the stats panel at the active day's now-real numbers (`distanceKm`, `durationMinutes`, `avgQuality`, surface mix). Remove the synthetic per-segment preview cards (or render them from real segment data later — out of scope now).

- [ ] **Step 5: Typecheck + manual verify + commit**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit` → clean.

```bash
git add "apps/companion/src/app/(dashboard)/trips/planner/page.tsx"
git commit -m "feat(companion): live planner route, Save, Fit route; hide Generate (phase 1)"
```

---

## Task 12: Retire the synthetic route builder

**Files:**

- Delete: `apps/companion/src/lib/trip-planner-builder.ts`
- Modify: any remaining importers (search first).

**Interfaces:** none new — removes the procedural geometry/stat code now fully replaced by the server route.

- [ ] **Step 1: Find references**

Run: `grep -rn "trip-planner-builder\|buildLegPoints\|buildRoutePoints" apps/companion/src` — list every importer.

- [ ] **Step 2: Remove usage + delete the file**

Replace each remaining importer's usage with the store's server-driven geometry (Task 9). Delete `trip-planner-builder.ts` and its test (if any).

- [ ] **Step 3: Typecheck + full companion test run**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit && pnpm --filter @tarmoto/companion exec vitest run`
Expected: clean + all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(companion): remove the synthetic route builder (replaced by live routing)"
```

---

## Task 13: Docs — manual planner test scenarios

**Files:**

- Modify: `docs/process/companion-testing-scenarios.md`

- [ ] **Step 1: Add scenarios**

Under the trip-planner section add rows:

```markdown
| Tx | Place start/end via menu | Right-click (or long-press) the map → "Set start here", then "Set end here" | A road-following route appears between them; map keeps your zoom |
| Tx | Add a via | With start+end set, right-click a road → "Add via here" | The route threads through the new point and re-snaps to roads |
| Tx | Drag to re-route | Drag a waypoint pin | The route recomputes live (debounced) and stays on roads |
| Tx | Save | Click Save with a valid start→end | Trip persists; reopening shows the same road route, framed once |
| Tx | Engine down | Stop the Valhalla container, edit a waypoint | Non-blocking error; last route kept; no crash |
```

- [ ] **Step 2: Commit**

```bash
git add docs/process/companion-testing-scenarios.md
git commit -m "docs(companion): manual test scenarios for the live route planner"
```

---

## Self-review notes

- **Spec coverage:** §1 interaction → Tasks 7,9,10; §2 live routing → Tasks 2,4,6,8,9,11; §3 Valhalla infra → Task 1; §4 persistence/save/hide-Generate → Tasks 5,9,11; retire synthetic → Task 12; §5 edge cases → Tasks 2 (null route), 4/5 (502), 8 (debounce/cancel), 10 (no auto-fit), 11 (save gating + toast); §6 testing → tests in Tasks 2–9,12 + docs Task 13.
- **Types consistent across tasks:** `RouteResult` (Task 2) → `RoutingProvider.route` (Tasks 4,5); `RouteMetrics` (Task 3) → `RouteEnrichmentService.aggregate` (Tasks 4,5); `RouteResponse`/`RouteRequestBody` (Task 6) → hook (Task 8) → `applyRouteResult` (Task 9); `PlacementActionId` (Task 7) → `placeWaypoint` (Task 9) → map (Task 10).
- **No multi-day / curvy / auto-gen** anywhere — deferred per spec.

## Out of scope (later phases)

Multi-day auto-itinerary; Calimoto curvy/scenic auto round-trips; curvy/motorcycle OSRM profile; drag-the-route-line-to-insert-via; smart fuel-stop insertion; per-vertex elevation; collaborative waypoint co-editing.
