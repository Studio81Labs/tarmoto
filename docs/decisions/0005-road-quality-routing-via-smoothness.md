# 0005 — Road-quality routing via OSM `smoothness` tag injection (GraphHopper)

**Status:** Accepted
**Date:** 2026-06-30

## Context

[ADR-0004](./0004-routing-engine-graphhopper.md) adopted GraphHopper so Tarmoto's crowdsourced per-segment quality (`road_segments.quality_score`) can eventually weight routing ("prefer good-surface roads" — `epic:road-quality`, issue #779). The hard, undecided part is _how_ our per-edge data reaches GraphHopper's weighting, which reads **encoded values** on its graph edges.

Constraints that shape the choice:

- GraphHopper has **no built-in "load my per-edge CSV"** path. A brand-new encoded value populated from arbitrary external data needs a custom Java `EncodedValue` + `TagParser`, which means **building and maintaining a forked image** — real ops + CI cost we want to avoid.
- The graph is imported from an OSM extract. We can **pre-process that extract** (inject OSM tags onto ways) on the way in, which the **stock image** already knows how to parse — _if the tag maps to a stock encoded value_.
- GraphHopper ships a **`smoothness`** encoded value (`OSMSmoothnessParser`, OSM `smoothness=excellent…impassable`). That scale is a near-direct analogue of our surface-quality score: "how good is the road surface to ride."
- `road_segments` carries `(osm_way_id, segment_index)` (#751), the join key back to OSM ways — though **nothing populates `osm_way_id` yet** (the OSM re-importer is separate, unbuilt).

## Decision

Conflate road quality into GraphHopper by **injecting an OSM `smoothness` tag** derived from `road_segments.quality_score`, and weight routes with a request-time `custom_model` over the **stock `smoothness` encoded value** — no forked image, no custom parser.

Quality → smoothness mapping (used by the future conflation job):

| `quality_score`               | OSM `smoothness`                 |
| ----------------------------- | -------------------------------- |
| 5                             | `excellent`                      |
| 4                             | `good`                           |
| 3                             | `intermediate`                   |
| 2                             | `bad`                            |
| 1                             | `very_bad`                       |
| `NULL` (no crowdsourced data) | _(no tag → `MISSING` → neutral)_ |

Three phases (this ADR + #779):

1. **Phase 3 — request-time weighting (this change).** `RoutingOptions.preferQuality` → a `custom_model` `priority` rule that **de-weights poor `smoothness`** (`BAD`/`VERY_BAD`/`HORRIBLE`/`IMPASSABLE`). Unknown/`MISSING` stays neutral, so segments without data are never penalised. Gated behind `TARMOTO_GRAPHHOPPER_QUALITY_ENABLED` (default off) — a silent no-op when off, exactly like the `toll` rule (RoutingProvider contract). `smoothness` added to `graph.encoded_values` in the self-hosted config.
2. **Phase 2 — conflation job (later).** Join `road_segments` → OSM ways via `(osm_way_id, segment_index)`, inject the `smoothness` tag into a derived `.pbf`, trigger a graph re-import. Blocked on `osm_way_id` being populated (the OSM importer).
3. **Curviness — deferred.** GraphHopper has **no stock encoded value** for curviness, so it can't ride the same tag-injection path; it would need the custom-parser (forked image) route. Out of scope until quality proves the approach.

## Consequences

- **Stays on the stock GraphHopper image** — the whole reason for the `smoothness` choice. No custom build, no CI image to maintain.
- **Quality weighting works the moment the conflation job runs** and the flag is set; until then it's a no-op, so this layer is safe to ship ahead of the data (same as `toll`).
- **Resolution caveat:** OSM tags attach to _ways_, but our quality is per ~100 m _segment_. The conflation job must either pick a representative value per way or split ways at segment boundaries — quantify the loss when Phase 2 lands.
- **Refresh latency:** `smoothness` is baked at import, so quality changes only take effect on the next graph re-import (weekly–monthly). The request-time `custom_model` tunes _how strongly_ to weight, not the underlying value.
- **Curviness is left behind** for now — the one place the stock-image constraint bites. Accept it; revisit with a custom parser only if curvy-road routing becomes a priority.
- **Coupling to a GraphHopper concept (`smoothness`)** in the conflation output. A future Valhalla path would map quality differently (tile attributes); kept tolerable because the _source_ (`quality_score`) stays engine-neutral and only the injection step is GraphHopper-shaped.

## Alternatives considered

- **Custom Java `EncodedValue` + `TagParser`.** The most faithful per-edge mapping and the only path for _curviness_, but it forks the stock image (build + CI + maintenance). Rejected as the default; revisit if `smoothness`'s per-way resolution proves inadequate.
- **A brand-new custom OSM tag (`tarmoto:quality`).** Same problem — the stock image has no parser for it, so it would need the Java path anyway. Reusing `smoothness` is what keeps us on the stock image.
- **Region-level custom areas.** Coarse polygons, not per-edge; can't express segment-level quality. Fallback only.
