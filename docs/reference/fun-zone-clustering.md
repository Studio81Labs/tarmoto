# Fun Zone clustering

How `fun_zones` and `fun_zone_roads` get populated for the trip planner heatmap (US-6, US-31) and the auto-generator (US-7, US-34).

## Pipeline

```
road_segments  ─►  eligibility filter  ─►  ST_ClusterDBSCAN  ─►  per-zone aggregate
                                                                       │
                                                                       ▼
                              fun_zone_roads  ◄─  upsert  ◄─  composite score + best season
                                                                       │
                                                                       ▼
                                                                  fun_zones
```

The whole job is wrapped in a single transaction and is idempotent — re-running on the same input yields the same row IDs and the same scores.

## Eligibility filter

A `road_segments` row enters the clustering candidate set only if all of the following hold:

| Field             | Default threshold | Why                                               |
| ----------------- | ----------------- | ------------------------------------------------- |
| `curviness_score` | `>= 2.0`          | Drop straight commuter roads.                     |
| `quality_score`   | `>= 3.0`          | Quality must be established and at least "fair".  |
| `confidence`      | `>= 50`           | Avoid clustering on barely-sampled roads.         |
| `length_m`        | `>= 500`          | Tiny segments add noise without adding ride time. |

Each threshold is overridable via CLI flags or service options.

## Clustering

`ST_ClusterDBSCAN(geom, eps := 0.045, minpoints := 3) OVER ()`

- `eps` is in degrees of arc — `0.045°` is roughly **3.2km** east-west and **5.0km** north-south at 50°N. This produces fun-zone-sized clusters without merging entire mountain ranges into a single mega-zone.
- `minpoints = 3` means a candidate must have at least 3 neighbours within `eps` to seed or extend a cluster; isolated curvy segments are noise and filtered out.
- The window has an explicit `ORDER BY id` — without it, PostGIS warns that border points may be assigned to different clusters across runs, which would churn zone IDs even when source data hasn't changed.
- After DBSCAN, clusters with fewer than `min_roads_per_zone` (default `3`) members are dropped.

The boundary polygon for each zone is the **convex hull of the buffered union** of member geometries:

```
ST_ConvexHull(ST_Buffer(ST_Collect(geom)::geography, hull_buffer_m)::geometry)
```

The buffer (default `250m`) keeps the polygon visibly enclosing the roads on a map at typical zoom levels.

## Composite score

A weighted sum mapped into `0..100`:

```
composite_score = 100 × (
    0.40 × clamp01(avg_curviness / 5)
  + 0.25 × clamp01((avg_quality - 1) / 4)
  + 0.15 × clamp01(elevation_range_m / 1500)
  + 0.15 × clamp01(road_count / 30)
  + 0.05 × clamp01(scenic_factor)
)
```

Weights live in `FUN_ZONE_SCORE_WEIGHTS` (`apps/backend/src/modules/roads/fun-zone-clustering.service.ts`). They sum to `1.0` and follow PRD §3.2:

- **Curviness (0.40)** — dominant signal for the target persona.
- **Quality (0.25)** — a fun road has to be rideable; quality keeps potholed corkscrews from grading too high.
- **Elevation variance (0.15)** — proxy for scenery and altitude variety in the zone.
- **Road density (0.15)** — denser networks let riders chain loops without doubling back.
- **Scenic factor (0.05)** — placeholder; stays `0` until a scenic source (POIs, viewshed, photo density) is wired.

`scenic_factor` is currently always `0`. To turn it on, populate the field at score time and the formula will pick it up without further changes.

The reference values used to map raw inputs into `0..1` are in `FUN_ZONE_SCORE_REFERENCES`. A zone at or above the reference saturates that component.

## Per-road contribution

Inside a zone, every member segment also gets a `contribution_score` so the zone-detail endpoint can rank "best roads in this zone":

```
contribution = clamp01(curviness / 5)
             × clamp01((quality - 1) / 4)
             × clamp01(length_m / 5000)
```

Multiplicative on `(curviness × quality × length)` — a long curvy smooth segment ranks above a short one of similar profile, a short curvy crap one is suppressed.

## `best_season`

Today's signal is **mountain passes** (`mountain_passes` table). For each zone, the pipeline checks if any pass lies inside the boundary:

- If at least one pass has a window narrower than year-round (`typical_open_month != 1` or `typical_close_month != 12`), the zone is `summer`.
- Otherwise the zone is `year_round`.

Closures (`road_closures`) are not yet folded in — passes are the strongest signal we have today, and a future ticket can layer closure-aware seasonality on top without reshaping the model. `spring`/`autumn` values remain available in the column and may be returned once a closure source is wired.

## Idempotency

A zone's primary key is

```
uuid_generate_v5(NAMESPACE, sorted_member_segment_ids_csv)
```

with `NAMESPACE = '47b1a8a9-8d67-4b28-9a1c-6cb72d6c4f01'`. The same input produces the same UUID, so two consecutive clustering runs against unchanged data yield zero churn on `fun_zones.id`. Small perturbations (a single segment flipping below the eligibility threshold) only change IDs for zones whose membership actually shifted, leaving the rest stable.

After upserting all candidate zones, the run deletes `fun_zones` rows whose IDs aren't in the latest candidate set so stale zones don't accumulate. **When a `--bbox` is supplied the prune is scoped to zones whose `boundary` intersects the bbox**, so a regional re-cluster never deletes zones outside the requested region. `fun_zone_roads` is wiped and rewritten per zone in the same transaction.

## Running the job

### CLI

```bash
pnpm --filter @tarmoto/backend cluster:fun-zones
# Flags (all optional):
#   --bbox=west,south,east,north
#   --eps=0.045
#   --min-points=3
#   --min-roads-per-zone=3
#   --min-curviness=2.0
#   --min-quality=3.0
#   --min-confidence=50
#   --min-segment-length-m=500
#   --hull-buffer-m=250
#   --no-prune
```

The CLI requires `pnpm build:backend` first (or `pnpm db:migrate` which builds along the way).

### Stored function

`db:migrate` installs `cluster_fun_zones(...)` as a server-side stored function. It mirrors the TypeScript scoring formula and is provided so an operator can re-cluster from `psql` or a backup-restore step without booting Nest:

```sql
SELECT cluster_fun_zones();
-- or with custom parameters
SELECT cluster_fun_zones(
  p_min_curviness     := 2.5,
  p_eps_degrees       := 0.060,
  p_min_roads_per_zone := 4
);
```

The TypeScript service stays the source of truth for scoring; the SQL function exists as an ops escape hatch.

### Demo seed (dev/staging)

The migration `AddFunZoneClusteringSeed1715300000000` inserts a small set of synthetic curvy `road_segments` (tagged `road_name LIKE 'seed:%'`) across the curated regions and runs one full clustering pass, so a fresh dev or staging DB has non-empty `fun_zones`. **It skips entirely when `TARMOTO_NODE_ENV=production`**, so production picks up real fun zones from rider-driven clustering only.

## Performance

- Eligibility filter is index-supported by `idx_road_segments_curviness` and `idx_road_segments_quality`.
- DBSCAN on the eligible set is `O(n log n)` with a GiST index on `geom` (the existing `idx_road_segments_geom`).
- Per-zone aggregates are a single `GROUP BY` over the clustered set.

A region the size of Tyrol or Beskydy clusters in well under 60s on a stock Postgres-16 + PostGIS-3.4 instance — the dominant cost is the convex-hull-of-buffer step which runs once per cluster, not per segment.
