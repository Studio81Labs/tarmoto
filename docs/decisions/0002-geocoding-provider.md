# 0002 — Nominatim as the geocoding provider

**Status:** Accepted
**Date:** 2026-04-21

## Context

US-47 shipped ride search by name. The follow-up (issue #177) adds "passes near `<place>`" search — rides whose route geometry intersects a disc around a user-provided place. That requires converting the place string ("Tatra Mountains", "Brno") to `(lat, lng)`, which the codebase doesn't do today.

Three candidates fit the problem:

- **Nominatim** — OSM-backed, free public instance at `nominatim.openstreetmap.org`, self-hostable, no API key, usage policy requires identifying the app via `User-Agent` and capping load to ≤1 req/s.
- **Mapbox Geocoding** — polished, fast, good autocomplete, but paid past a small free tier and requires an API key tied to billing.
- **Pelias** — self-hosted geocoder that can mix multiple sources (OSM, Who's on First, OpenAddresses). Most flexible, but operationally expensive — a full Pelias stack needs 4–6 services and tens of GB of indexed data.

Constraints that shape the choice:

- The rest of the stack is already OSM + MapLibre + custom tiles (see `infra-79`). A second data lineage would only introduce drift between what the map renders and what geocoding resolves to.
- The backend is a single NestJS process without a managed-key vault at this stage; avoiding credentialed external services keeps setup friction low for contributors.
- Expected query volume is rider-typed search, not programmatic fan-out — under 1 req/s per user is a fine ceiling for the foreseeable future.

## Decision

The backend proxies geocoding through **Nominatim** via a new `GET /api/v1/geocode?q=` endpoint. The proxy:

- Calls the public `nominatim.openstreetmap.org` instance by default (`TARMOTO_NOMINATIM_URL` overrides for self-hosted deployments).
- Sends a descriptive `User-Agent` identifying Tarmoto, per Nominatim's usage policy.
- Applies a short request timeout via `AbortController` (matching the Overpass provider pattern in `apps/backend/src/modules/poi/providers/overpass.provider.ts`).
- Returns a normalized list of `{ label, lat, lng, importance }` results — not the raw Nominatim payload — so swapping providers later is a one-module change.

Proxying (rather than having the companion call Nominatim directly) is intentional: it centralizes the `User-Agent`, lets us move to a rate-limited cache or self-hosted instance without a web release, and avoids leaking rider IPs to a third-party.

## Consequences

- No API key or billing surface; contributors can run the feature end-to-end with `pnpm install`.
- We accept public Nominatim's usage cap (≤1 req/s per source IP) and TOS. If product usage outgrows it, the escape hatch is standing up a private Nominatim via `TARMOTO_NOMINATIM_URL` — no code change required.
- Geocoding quality is "good enough" for place-name queries common to motorcycle touring (regions, passes, towns). It is noticeably weaker than Mapbox for structured addresses; that's acceptable because ride search is about regions and landmarks, not street addresses.
- One more external dependency to mock in tests — but the provider interface mirrors the POI one, so the test pattern is already established.

## Alternatives considered

- **Mapbox Geocoding.** Rejected — introduces a paid, keyed dependency for a feature that doesn't need autocomplete polish, and creates drift between map tiles (OSM) and geocoding source.
- **Pelias (self-hosted).** Rejected — operationally too heavy for the current scale. Worth revisiting if we later need multi-source geocoding or offline installs.
- **Companion calls Nominatim directly.** Rejected — leaks rider IPs, scatters `User-Agent` policy compliance across clients, and blocks the caching/private-instance escape hatch.

## Follow-up

- **#909 — backend cache, per-user throttle, and upstream 1/s serialization.** As the proxy gained more typeahead consumers (explore, ride search, planner), we landed the "rate-limited cache" this ADR anticipated, plus the serialization needed to actually honour Nominatim's ≤ 1 req/s: (1) a bounded TTL response cache on `GeocodeService` (forward + reverse) collapses repeated queries; (2) a per-user `@Throttle` on `GeocodeController`, shared across both actions via `@SharedThrottleBucket`, caps any single client; (3) a min-spacing limiter in `NominatimProvider` serializes upstream calls to ≤ 1/s **when the public instance is in use**, shedding bursts (e.g. the planner naming several pins at once) as graceful fallbacks rather than firing them in parallel. Overriding `TARMOTO_NOMINATIM_URL` to a self-hosted instance is auto-detected and disables the serializer (no OSMF cap applies) — the durable, cross-instance fix.
