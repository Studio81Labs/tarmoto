# Road-quality → GraphHopper conflation (#779, ADR-0005)

Feeds Tarmoto's crowdsourced per-segment `road_segments.quality_score` into
GraphHopper so routing can **prefer good-surface roads** (`epic:road-quality`).
GraphHopper weights routes off **encoded values** on its graph edges and has no
"load my per-edge CSV" path, so — per [ADR-0005](../../../../../../docs/decisions/0005-road-quality-routing-via-smoothness.md)
— quality rides in on the **stock `smoothness` encoded value**: the conflation
job injects an OSM `smoothness` tag derived from our score, and the request-time
`custom_model` de-weights the poor tiers. No forked image, no custom parser.

```
road_segments.quality_score ──(this core)──► per-way smoothness assignments
                                              │
                                              ▼
                                inject smoothness tag into derived .osm
                                              │
                                              ▼ (operator/infra)
                                   GraphHopper graph re-import
                                              │
                                              ▼
              RoutingOptions.preferQuality → custom_model over `smoothness`
```

## What lives here

- **`quality-smoothness.ts`** — the pure `quality_score → smoothness` mapping.
  `quality_score` is continuous in `[1, 5]`; it maps to the nearest ADR-0005
  tier (`1 → very_bad … 5 → excellent`). `NULL`/non-finite → no tag, so an
  unscored road stays `MISSING`/neutral and is **never penalised**. Single
  source of truth for the boundaries; unit-tested in one place.
- **`quality-conflation.service.ts`** — `QualityConflationService`:
  - `buildConflation()` joins our ~100 m segments back to their OSM way via
    `osm_way_id`, collapses each way to a **length-weighted mean** of its live,
    scored segments, maps that to a `smoothness` tier, and returns the per-way
    `WaySmoothnessAssignment[]`.
  - `runConflation()` runs `buildConflation()` then streams the configured input
    `.osm` extract to the output path, injecting the tags — the artifact the
    GraphHopper re-import consumes.
- **`smoothness-injection.ts`** — the streaming OSM-XML rewriter. Passes every
  element through (nodes, ways, relations, bounds) and writes
  `<tag k="smoothness" v="…"/>` onto each matched way, **replacing** any existing
  `smoothness` so re-running is idempotent. Semantically (not byte-) faithful;
  bounded memory (one way in flight).
- **`quality-conflation.config.ts`** — `TARMOTO_QUALITY_CONFLATION_ENABLED`
  (default off) + input/output `.osm` paths; region reuses
  `TARMOTO_OSM_IMPORT_BBOX`.
- Wired as the **`quality.conflation` BullMQ queue** (`jobs.constants.ts`),
  processed by `QualityConflationProcessor`. It is **not** independently
  scheduled: the OSM import processor enqueues it as a **success-continuation**,
  so it only runs after a successful import and can never race a long-running or
  failed one (a fixed 02:00 cron could). Dormant (the processor no-ops) unless
  enabled.

### Behaviour

- **Live only.** Tombstoned segments (`deactivated_at IS NOT NULL`, #835) are
  excluded, so a road removed from OSM stops contributing stale quality.
- **Scored only.** Ways whose segments are all `quality_score IS NULL` produce
  no assignment (neutral), matching the request-time no-op contract.
- **Owns the `smoothness` channel.** The injector strips **every** source
  `smoothness` tag (ADR-0005): a matched way gets our conflated value; an
  unscored way is left with none → `MISSING`/neutral. Otherwise a source
  `smoothness=bad` on a road we have no data for would be de-weighted by
  `preferQuality` — penalising it against the contract.
- **Atomic output.** The derived extract is written to a temp sibling and
  renamed on success, so a failed/partial run never truncates the last good
  extract GraphHopper imports.
- **Region-bounded.** When `TARMOTO_OSM_IMPORT_BBOX` is set the job only conflates
  ways intersecting that rectangle — the same region the OSM extract and the
  GraphHopper graph cover. Unset → the whole live network.
- **Idempotent.** Reads current aggregates only; re-running yields the same
  artifact until the underlying scores change.

### Resolution caveat

OSM tags attach to whole ways, but quality is per ~100 m segment, so the per-way
length-weighted mean loses sub-way resolution (ADR-0005). Splitting ways at
segment boundaries for full fidelity is a future refinement once the per-way
loss is measured on a real region.

## Operator prep

Point the job at the extract to tag (normally the same one GraphHopper imports)
and a derived output path, and enable it:

```bash
TARMOTO_QUALITY_CONFLATION_ENABLED=true
TARMOTO_QUALITY_CONFLATION_INPUT_FILE=/data/czech.osm       # osmium-produced .osm XML
TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE=/data/czech.quality.osm
# region reuses TARMOTO_OSM_IMPORT_BBOX
```

The job writes `…/czech.quality.osm` weekly; wire the **GraphHopper import to that
file** so the fresh `smoothness` bakes into the graph on re-import.

## Not done here (needs running infra)

Two things can't be built or validated without a running GraphHopper + a real
extract, so they stay operator/follow-up:

1. **Graph re-import trigger.** GraphHopper bakes `smoothness` at import time;
   pointing its import at the derived `.osm` and re-importing (reusing the #778
   infra) is an ops step, not something this job triggers.
2. **Proof.** Show a `preferQuality` route demonstrably avoiding a low-quality
   way vs the baseline on the Czech extract (ADR-0005's Phase-1 acceptance).

Until the graph carries the tag, `GraphHopperProvider.preferQuality` stays a
no-op behind `TARMOTO_GRAPHHOPPER_QUALITY_ENABLED` (default off) — the
request-time layer is already shipped and safe ahead of the data, like `toll`.
