# 0009 — Mapillary as the street-level imagery provider

**Status:** Accepted
**Date:** 2026-07-08

## Context

The planner's Road Preview card (#863) shows a small street-level photo of the hovered road section as a secondary, "confirmation only" signal next to the measured quality score. Until now that photo was a fabricated placeholder (a stylised road perspective) with a fake capture date — the mock in `apps/companion/src/lib/planner/mocks/previews.ts`.

Making it real needs a source of street-level imagery keyed by coordinate, with a genuine capture date and a licence we can honour. Candidates:

- **Mapillary** — crowd-sourced street-level imagery, free Graph API v4, global coverage, spatial search by radius/bbox, per-image `captured_at` and thumbnails. Requires a client access token. Imagery is **CC-BY-SA** (attribution + share-alike).
- **Google Street View Static API** — best coverage/quality, but paid per request, key tied to billing, and restrictive TOS (no caching/redistribution). The card already links out to Google Street View for a full look; embedding static tiles is a different, licence-heavy commitment.
- **KartaView (ex-OpenStreetCam)** — open imagery like Mapillary but sparser coverage, especially outside cities.

Constraints that shape the choice:

- The rest of the stack is OSM-native (see ADR-0002, ADR-0008). Mapillary is OSM-adjacent and CC-BY-SA, consistent with our existing open-data lineage.
- This is a **P3 enhancement popover, not a blocking path** — it must degrade gracefully to "no imagery" and never fail the card.
- The backend already has a proven proxy pattern for a keyed/rate-limited external source (the Nominatim geocode proxy, ADR-0002 / #909): provider interface + service + `TtlCache`.

## Decision

The backend proxies street-level imagery through **Mapillary** via a new `GET /api/v1/roads/segment-imagery?lat=&lng=&bearing=` endpoint, backed by a `modules/mapillary/` module that mirrors the geocode proxy:

- `MapillaryGraphProvider` calls Graph API v4 `graph.mapillary.com/images` (radius search, capped at 50 m) with a client access token from **`TARMOTO_MAPILLARY_TOKEN`**, preferring a flat (non-pano) frame whose compass angle best matches the travel `bearing`.
- `MapillaryService` caches results (12 h TTL, bounded LRU) — including "no coverage" — so repeated hovers don't re-query. Only thrown errors stay uncached.
- The endpoint returns a normalized `{ imageId, capturedAt, attribution, link }` (all nullable), **not** the raw Mapillary payload, so swapping providers later is a one-module change. `attribution` + `link` carry the required CC-BY-SA credit, which the companion renders as a link back to the image page.
- The **thumbnail itself is proxied**: the client loads it from `GET /roads/segment-imagery/thumb/{imageId}`, which streams the bytes server-side (byte-cached). So the rider's browser never contacts Mapillary's CDN — no IP or viewed-section leak. That endpoint is necessarily public (an `<img>` can't send a bearer) but rate-limited, and only proxies public Mapillary thumbnails (no rider data).

Proxying (rather than the companion calling Mapillary directly) is deliberate: it keeps the token **server-side**, lets us cache/rate-limit centrally, and avoids leaking rider IPs + hover coordinates to a third party.

The **per-metre quality strip** (the card's other real-data item in #863) is NOT part of this decision — it needs no external source. `surface_readings` are keyed per `road_segment`, so the strip is derived client-side from the real per-road-segment scores within a coalesced run (see #863).

## Consequences

- The feature is **opt-in via a token**. With `TARMOTO_MAPILLARY_TOKEN` unset, the provider is inert and the card shows "no street imagery" — contributors can run everything end-to-end with `pnpm install` and simply see no photos.
- We take on the **CC-BY-SA attribution + share-alike** obligation for displayed imagery. The card renders the per-image credit; share-alike applies only if we redistribute the imagery itself (we display Mapillary-hosted thumbnails, not re-host them).
- Coverage is uneven — rural passes may have no imagery within 50 m of a segment midpoint. That's acceptable for a confirmation-only signal; the card degrades to the placeholder + the existing Google Street View out-link.
- One more external dependency to mock in tests — but the provider interface mirrors the geocode one, so the pattern is established.
- Mapillary's search API allows 10,000 req/min per app; combined with the response cache and an authenticated, per-user-throttled endpoint, quota is not a concern at rider-hover volume.

## Alternatives considered

- **Google Street View Static API** — rejected: paid, billing-keyed, and its TOS forbids the caching we rely on for a hover popover. We keep Street View as an out-link only.
- **KartaView** — rejected for now: sparser coverage would make the card empty more often. The provider interface leaves the door open to add it (or a multi-source fallback) later.
- **Companion → Mapillary directly** — rejected: would ship the token to the browser and leak rider coordinates/IPs to Mapillary, and give us no central cache or rate limit.
