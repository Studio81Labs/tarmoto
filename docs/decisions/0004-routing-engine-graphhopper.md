# 0004 — GraphHopper as the routing engine for road-filter & quality-weighted routing

**Status:** Proposed
**Date:** 2026-06-30

## Context

Routing sits behind the `RoutingProvider` interface (`route`, `getAlternatives`, `version`) with a `ROUTING_PROVIDER` token selected by `routingProviderFactory`. Two engines exist: **OSRM** (default, public demo) and **Valhalla** (opt-in via `TARMOTO_VALHALLA_BASE_URL`). Consumers — commute, the trip generator, and the `/routing/route` planner endpoint — are engine-agnostic.

Two product needs push beyond what's wired today:

1. **Road filters now.** Riders want to avoid highways / tolls, and the trip planner must route around active full closures (`exclude_polygons`, #744). The public OSRM demo can't help: it rejects _every_ `exclude=` flag with `400` (verified against `router.project-osrm.org` — `exclude=motorway` and `exclude=toll` both 400), so toggling avoidance breaks routing entirely on the default engine.
2. **Quality-weighted routing later (the moat).** Tarmoto's differentiator is crowdsourced per-segment surface quality + curviness on `road_segments`. The flagship feature is routing that _prefers_ good-surface / curvy roads ("fun roads"). That is fundamentally an **iterative tuning** problem — "how strongly do we prefer quality vs. distance?" — that we expect to adjust often.

The engines differ structurally in _how_ you express avoidance and custom weighting:

- **Valhalla:** per-request `costing_options` cover the built-in knobs (`use_highways`, `use_tolls`) and `exclude_polygons`. But weighting by **our own per-edge data** means baking attributes into the routing tiles at build time, and anything beyond the built-in costing requires a **forked C++ costing model + recompile**. Tuning is a rebuild/fork loop.
- **GraphHopper:** avoidance and weighting are a request-time JSON **`custom_model`** (`priority`/`speed` rules over encoded values like `road_class`, `toll`, plus imported custom encoded values) with **`areas`** for polygon exclusions. Custom models require flexible mode (`ch.disable: true`). Introducing a _new_ edge attribute still needs a graph re-import, but the **weighting logic is tuned in JSON at request time, with no engine rebuild**.

The genuinely expensive work — conflating `road_segments` quality/curviness onto routing-graph edges — is engine-agnostic and unavoidable either way.

## Decision

Adopt **GraphHopper** as the strategic routing engine for road-filter and quality-weighted routing, added as a third `RoutingProvider` behind the existing seam. Selection precedence in `routingProviderFactory` becomes **GraphHopper → Valhalla (`TARMOTO_VALHALLA_BASE_URL`) → OSRM**. GraphHopper is selected by **either** `TARMOTO_GRAPHHOPPER_BASE_URL` (self-hosted) **or** `TARMOTO_GRAPHHOPPER_API_KEY` (hosted Directions API) — the key-only hosted setup must not be silently ignored. OSRM stays the zero-config default so `pnpm db:up` still routes out of the box; GraphHopper and Valhalla remain opt-in.

`RoutingOptions` map to a GraphHopper `custom_model`:

- `avoidHighways` → `priority` rule zeroing `road_class == MOTORWAY`
- `avoidTolls` → `priority` rule zeroing `toll != NO`
- `excludePolygons` (#744) → `custom_model.areas` polygons + a `priority` rule zeroing anything `in_<area>`

Self-hosted by default (`http://localhost:8989`); setting `TARMOTO_GRAPHHOPPER_API_KEY` alone both selects GraphHopper and defaults its base URL to the hosted GraphHopper Directions API (`https://graphhopper.com/api/1`) for a zero-infra trial — an explicit `TARMOTO_GRAPHHOPPER_BASE_URL` always wins. We request `points_encoded: false` to consume GeoJSON directly.

This ADR covers the _provider_. The data-conflation pipeline (mapping `road_segments` quality → a GraphHopper encoded value) and turning quality-weighting on are deliberately separate, later work.

## Consequences

- **Road filters and closure avoidance work properly**, request-time, on a supported engine — unlike the OSRM demo. The `/routing` `exclude=` 400s go away once GraphHopper is the configured engine.
- **The moat feature gets a fast iteration loop:** quality/curviness weighting will live in request-time `custom_model` JSON, so we tune preference strength without rebuilding the engine.
- **Flexible mode is the cost.** Custom models and alternative routes require `ch.disable: true`, which is slower than Contraction Hierarchies. Acceptable for our query profile (rider-initiated planning, not programmatic fan-out); mitigated by GraphHopper Landmarks if needed.
- **Operational surface grows:** a self-hosted GraphHopper needs a regional OSM extract + a docker service (behind the `routing` compose profile, like Valhalla). The hosted API removes that for trials but adds a key + cost.
- **No consumer changes and no breaking changes** — the swap is additive; `version` (`graphhopper-v1`) drives cache invalidation (#361). OSRM and Valhalla remain fully supported and selectable.
- We keep **three** engines to maintain. That's intentional: OSRM for zero-config dev, Valhalla retained as a proven fallback, GraphHopper as the strategic target.

## Alternatives considered

- **Stay on Valhalla.** Rejected as the _primary_ path for quality-weighting because per-edge custom weighting pushes us into tile-baking and a forked C++ costing model — a slow loop for a feature we expect to tune continuously. Valhalla remains a first-class supported engine and sensible fallback; its `exclude_polygons` / costing options already work via the existing provider.
- **Stay on OSRM.** Rejected for anything beyond zero-config dev: the public demo can't do exclusions at all, and OSRM's customization (custom Lua profiles compiled into the graph) is the least iterable of the three. Kept as the default only because it routes with no setup.
- **Hosted commercial routing (Mapbox/GraphHopper SaaS) permanently.** Rejected as the end state — recurring per-request cost and a keyed dependency for a core capability — but the GraphHopper hosted API is an acceptable _interim_ to validate the model before standing up self-hosted infra.
