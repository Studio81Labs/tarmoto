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
                                              ▼ (follow-up, infra)
                                   inject smoothness tag into derived .pbf
                                              │
                                              ▼
                                   GraphHopper graph re-import
                                              │
                                              ▼
              RoutingOptions.preferQuality → custom_model over `smoothness`
```

## What lives here (the engine-neutral core)

- **`quality-smoothness.ts`** — the pure `quality_score → smoothness` mapping.
  `quality_score` is continuous in `[1, 5]`; it maps to the nearest ADR-0005
  tier (`1 → very_bad … 5 → excellent`). `NULL`/non-finite → no tag, so an
  unscored road stays `MISSING`/neutral and is **never penalised**. Single
  source of truth for the boundaries; unit-tested in one place.
- **`quality-conflation.service.ts`** — `QualityConflationService.buildConflation()`
  joins our ~100 m segments back to their OSM way via `osm_way_id`, collapses
  each way to a **length-weighted mean** of its live, scored segments, maps that
  to a `smoothness` tier, and returns the per-way `WaySmoothnessAssignment[]` —
  exactly the artifact an osmium tag-injection pass consumes.

### Behaviour

- **Live only.** Tombstoned segments (`deactivated_at IS NOT NULL`, #835) are
  excluded, so a road removed from OSM stops contributing stale quality.
- **Scored only.** Ways whose segments are all `quality_score IS NULL` produce
  no assignment (neutral), matching the request-time no-op contract.
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

## Not yet wired (documented follow-up)

The **deployment-shaped** half of Phase 2 is intentionally out of this slice — it
needs `osmium`/PBF tooling and a running GraphHopper, and its acceptance proof is
a live route reroute on the Czech extract:

1. **PBF tag injection.** Rewrite the OSM extract writing each assignment's
   `smoothness` tag onto its way (`osmium` / a PBF writer), producing a derived
   `.pbf`.
2. **Graph re-import trigger.** Re-import the derived `.pbf` into GraphHopper
   (reusing the #778 import infra) so the new `smoothness` bakes into the graph.
3. **Job wiring.** A BullMQ queue + processor (mirroring `osm-import.processor`),
   recurring after the OSM import so the graph is fresh, gated by its own enable
   flag; dormant by default.
4. **Proof.** Show a `preferQuality` route demonstrably avoiding a low-quality
   way vs the baseline on the Czech extract (extends ADR-0005's Phase-1 goal).

Until then, `GraphHopperProvider.preferQuality` stays a no-op behind
`TARMOTO_GRAPHHOPPER_QUALITY_ENABLED` (default off) — the request-time layer is
already shipped and safe ahead of the data, exactly like the `toll` rule.
