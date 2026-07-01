# 6. OSM way split/merge — geometry-overlap identity reassignment

Date: 2026-07-01

## Status

Accepted

## Context

`road_segments` UUIDs are the anchor for all crowdsourced data — `surface_readings`,
`road_reviews`, `hazard_reports`, `fun_zone_roads` all FK to a segment id. The OSM
importer (#781) keeps those UUIDs stable across re-imports by upserting on the
`(osm_way_id, segment_index)` identity (#751): re-running the same snapshot
matches every row and preserves its id + history.

That key is only stable while OSM's way boundaries are. Between snapshots an
editor can **split** one way into two (or **merge** two into one). When that
happens the affected stretch gets a different `osm_way_id` and/or a reset
`segment_index`, so a plain upsert:

- **inserts fresh rows** (new UUIDs) for the "new" segments, and
- **orphans the old rows** (their `(osm_way_id, segment_index)` is absent from the
  snapshot),

stranding the quality/review/hazard history on the orphaned ids even though the
road on the ground is unchanged. §8.5 of the data reference flagged this as the
open policy question to settle when the importer landed.

The importer is otherwise complete (segmentation → decode → assemble → upsert →
scheduled job), so this is the last correctness gap before it runs on successive
real snapshots.

## Decision

Reassign identity by **geometry overlap** for the changed ranges, so history
follows the road, not the way id.

Before upserting a region, match each **incoming** ~100 m segment against the
**existing** rows in the same area by how much of the incoming segment's length
lies on an existing segment's geometry (sampled-point coverage within a small
tolerance). A greedy pass — highest overlap first, each existing row inherited by
at most one incoming segment — produces three sets:

- **carry-over** — the incoming segment inherits the existing row's UUID (and all
  its FKs/history); the upsert updates that row's OSM columns in place.
- **insert** — no existing segment overlaps; a genuinely new stretch, fresh UUID.
- **stale** — an existing row nothing overlaps; the road it represented is gone
  from the snapshot. It is **tombstoned/deactivated, not hard-deleted** — the
  crowdsourced history (`surface_readings`, `road_reviews`, `hazard_reports`,
  `fun_zone_roads`) still FKs to it, and a delete would either fail on those
  constraints or destroy the very history this policy exists to preserve.

Overlap is measured **bidirectionally** — the max of "fraction of the incoming
on the existing" and "fraction of the existing on the incoming". A 1:1 match or
a contained stretch (either side of a split/merge) scores ~1.0, while a short
partial overlap of two mostly-different stretches stays low both ways. A
carry-over requires a **strict majority** (> 0.5), so a segment overlapping only
a minority of an existing row (a mostly-new or extended stretch) is inserted
fresh rather than silently inheriting another road's reviews. A **partial**
majority also requires the shared **length** to exceed a tolerance-aware floor
(> 2·tolerance): two very short segments that merely touch at an endpoint each
have ~tolerance of length within tolerance of the other's tip — a false majority
for ~10 m stubs — so the floor stops one stub's identity leaking onto an adjacent
road. A **near-perfect** match (score ≥ 0.9 — an unchanged segment, or one fully
contained in another on a split/merge) bypasses this floor: it is genuine at any
length, so an idempotent re-import of a sub-10 m connector/driveway keeps its id
instead of being tombstoned and reinserted.

Because each existing id is claimed once:

- a **1→2 split** carries history to the better-covered half and inserts the
  other half fresh (history stays with one continuous stretch rather than being
  duplicated or lost);
- a **2→1 merge** inherits one old row's history for the merged road and marks
  the other stale (its history is not blended — merging crowdsourced aggregates
  across segments is out of scope);
- **unchanged segmentation** carries every id over (a no-op re-import).

The matching heart is a **pure, PostGIS-free core** (`split-merge.ts`,
`planReassignment`) operating on coordinate arrays with a planar overlap metric —
exact enough on ~100 m spans and unit-testable from synthetic geometries. Loading
the candidate existing rows and applying the plan (carry-over as an
id-preserving update, stale as a tombstone/deactivation) is a follow-up wiring
slice — a follow-up that must add the deactivation column/flag rather than hard-
delete, since the history tables FK to `road_segments`.

Defaults: **overlap threshold 0.5** — a strict majority, i.e. a carry-over needs
a score above `0.5`; **tolerance 5 m** (tight, because an OSM re-split reuses the
same node coordinates so matching stretches are near-exact; a looser value would
inflate a partial overlap past the cutoff); **sample spacing 20 m** (samples
placed evenly by arc-length, so the on-line fraction approximates the overlapping
_length_).

## Consequences

- Quality/review/hazard history survives OSM re-splitting and merging of ways,
  not just idempotent re-imports — the point of the stable-identity work (#751).
- The policy is lossy by design at split/merge boundaries: on a merge one side's
  history is dropped; on a split only one side keeps history. This is acceptable
  and preferable to duplicating or orphaning it; a future refinement could blend
  aggregates when a merge is detected.
- The threshold/tolerance are heuristics. They must be validated against real
  Geofabrik snapshot deltas, and the **misassignment rate quantified**, before the
  scheduled job is enabled on a live region — a wrong carry-over silently
  reattaches one road's reviews to another. Until then the importer stays off by
  default (`TARMOTO_OSM_IMPORT_ENABLED=false`).
- Applying the plan needs the candidate existing rows for the region loaded and
  spatially indexed; the `geom` GiST index already exists.

## Alternatives considered

- **Do nothing (accept orphans).** Simplest, but defeats #751 the moment OSM edits
  a way — history silently detaches from the road. Rejected.
- **Match on tags (name/ref) instead of geometry.** Names are missing or shared
  across unrelated roads and don't survive a split cleanly; geometry is the
  ground truth for "same stretch". Rejected as the primary signal (could be a
  tie-breaker later).
- **Full bipartite optimum (Hungarian) instead of greedy.** Marginally better
  assignments in dense overlaps, but the segments are short and mostly 1:1 or
  simple split/merge; greedy-by-overlap is deterministic, O(n·m), and good enough.
  Revisit only if the measured misassignment rate warrants it.
- **osmium-based change detection between PBF snapshots.** Precise, but adds an
  external diffing step and still needs a geometry mapping for the reshaped
  stretch; the in-import overlap match subsumes it without new infra.
