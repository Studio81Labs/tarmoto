/**
 * All fabricated planner data lives in this folder — nothing outside
 * `lib/planner` may import it directly. Components consume it only through
 * `plannerApi` (`../api.ts`), so swapping any mock for the real source is a
 * one-file change there.
 *
 * Currently mocked (no backend source yet):
 *  - road preview payloads incl. street-level capture metadata (`mockRoadPreview`)
 *  - geocoding, forward + reverse (`mockGeocode` / `mockReverseGeocode` —
 *    real target: self-hosted Nominatim/Photon)
 *  - map-toolbar category POIs, mixed-source (`mockPoisByCategories` —
 *    real target: OSM + seasonal passes + Tarmoto curviness layer)
 *
 * Deliberately NOT mocked, despite the original brief assuming they would
 * be: route distance/time/score/surface-mix (real routing response),
 * per-segment surface quality (real `POST /roads/route-quality`, mapped in
 * `../route-quality`), POIs (real `/poi/*` endpoints), seasonal pass statuses
 * and closures (real passes/closures APIs already wired into the planner panels).
 */
export { mockRoadPreview } from "./previews";
export { mockGeocode, mockReverseGeocode } from "./geocode";
export { mockPoisByCategories, mockRouteStops } from "./pois";
