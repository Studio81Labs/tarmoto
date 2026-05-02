/**
 * Re-export of the array-shaped maplibre style expression type.
 *
 * `maplibre-gl@5.24.0` no longer publicly re-exports the recursive
 * `ExpressionSpecification` type from its top-level entry, even
 * though the underlying `@maplibre/maplibre-gl-style-spec@24.x` still
 * does. Routing every companion callsite through this single module
 * keeps the deep import in one place — when maplibre-gl restores the
 * top-level re-export, only this file needs to change.
 */
export type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
