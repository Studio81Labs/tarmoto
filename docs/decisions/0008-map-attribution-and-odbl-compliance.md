# 0008 — Map attribution & ODbL compliance

**Status:** Accepted
**Date:** 2026-07-07

## Context

The companion renders an [OpenFreeMap](https://openfreemap.org/) base map (OpenMapTiles schema, OpenStreetMap data) and is about to start serving **OpenStreetMap-derived POIs** (fetched via Overpass, stored in the `pois` table) to end users. OSM data is licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/), which requires **attribution** ("© OpenStreetMap contributors") and carries a **share-alike** obligation on derived databases. The base-map providers (OpenFreeMap, OpenMapTiles) also require credit under their terms.

Before POIs are shown to users, attribution has to be correct and legible. Two problems stood in the way:

1. **The base-map credit was an unlinked blob.** The OpenFreeMap style delivers its attribution through a TileJSON (`.../planet`), not the style JSON — its vector source carries only a `url`, and MapLibre fetches that TileJSON and appends its attribution as a single, unlinked string: `OpenFreeMap © OpenMapTiles Data from OpenStreetMap`. There was no separate, clickable OSM credit.
2. **POIs had no attribution at all**, because the POI GeoJSON layer is added client-side and carried no `attribution`.

Mobile is out of scope here — it is a prepared UI shell, not a shipping client, and its POI/attribution work is tracked separately in **#901**. This decision covers the **companion** only.

## Decision

Attribute OSM and the base-map providers directly in the companion map UI:

- **Map attribution control** shows a curated, linked, provenance-ordered row: **`© OpenStreetMap contributors | © OpenMapTiles | OpenFreeMap`** (raw data → tile schema → tile host). The aerial basemap continues to add `© ČÚZK` when active.
- **POI popover** credits OSM (`© OpenStreetMap contributors`) when the selected POI's `source` is `osm`.
- **Trip STOPS panel** — its `OSM` legend dot links to the OSM copyright page (the full credit stays on the map control, so the panel isn't duplicated).

To produce the curated row we **inline the base-map TileJSON on style load** (`loadCuratedMapStyle` in `apps/companion/src/components/map/attribution.ts`): the source's tile config is copied onto the source and its `url` + `attribution` are dropped, so MapLibre never fetches the credit-bearing TileJSON. The attribution control is then driven by our own `customAttribution` (a single joined string of linked credits, so the order is deterministic — MapLibre length-sorts multiple entries). The POI layer reuses the **exact** OSM credit string, which MapLibre collapses into the base-map credit (it drops any attribution entry that is a substring of a longer one), so OSM is shown exactly once whether or not POIs are visible.

**Every provider stays credited** — this only reformats the presentation; it never drops a credit. If the curated-style fetch fails, we fall back to the provider's own (unlinked) attribution rather than losing it.

## Consequences

- The ODbL attribution obligation and the base-map providers' credit terms are met for the data the companion serves today.
- **Share-alike reinforces the OSM/Overture non-conflation rule** ([`data-sources-and-storage.md` §8.3](../reference/data-sources-and-storage.md)): because our derived POI database inherits ODbL, Overture (CDLA-Permissive) gap-fill must stay a **separate, source-tagged layer**, never row-level merged into OSM records, or the whole table is forced under ODbL.
- The curation is **provider-specific**: it strips the current base map's baked-in credit and re-adds a curated list. Swapping the base map, or adding another tiled data source, requires re-checking attribution and updating `BASE_MAP_ATTRIBUTION`.
- **Mobile must implement equivalent attribution before it ships POIs** (#901); this ADR does not cover it.
- Attribution correctness is now protected by unit tests (`attribution.test.ts`): the TileJSON-inlining, the graceful fallbacks, the OSM-first order, and the substring-dedupe invariant that keeps the POI credit from doubling.

## Alternatives considered

- **Leave the base-map blob as-is.** Rejected: it is unlinked, unordered, and mixes three providers into one opaque string — poor UX and a weak reading of the attribution requirement now that we also serve OSM POIs.
- **Disable MapLibre's control and render a fully custom attribution element.** Rejected: it drops the control's automatic per-source crediting (e.g. the aerial `© ČÚZK` basemap), duplicating state we would have to keep in sync by hand.
- **Set the source's inline `attribution` to `""` and keep its `url`.** Rejected: the TileJSON's attribution overrides the inline value once it loads, so the blob returns anyway — hence inlining the TileJSON and dropping the `url` outright.
