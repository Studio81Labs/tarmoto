import type { SurfaceType } from "@tarmoto/shared";
import { scoreToBand } from "../quality-bands";
import type { SegmentSlice } from "../segmentize";
import type { QualityBand, RouteSegment } from "../types";
import { hashLineString, seededSequence } from "./hash";

/**
 * MOCK per-segment quality join. The quality pipeline doesn't serve
 * per-segment scores for arbitrary routed geometry yet, so this fabricates
 * a plausible, deterministic quality story for each segment slice:
 * mostly good tarmac, occasional fair/rough sections, and the odd
 * unmeasured stretch — including a few low-pass-count segments so the
 * low-confidence treatment has something real to render.
 *
 * Replacing this with the real join (keyed by segment/OSM way id) is the
 * `generateRoute` step in `../api.ts` — no component changes needed.
 */

interface BandProfile {
  band: QualityBand;
  scoreRange: [number, number];
  surfaces: SurfaceType[];
  passesRange: [number, number];
}

const BAND_PROFILES: BandProfile[] = [
  {
    band: "good",
    scoreRange: [3.6, 4.8],
    surfaces: ["asphalt", "asphalt", "asphalt", "concrete"],
    passesRange: [12, 80],
  },
  {
    band: "fair",
    scoreRange: [2.5, 3.4],
    surfaces: ["asphalt", "concrete", "cobblestone"],
    passesRange: [6, 40],
  },
  {
    band: "rough",
    scoreRange: [1.2, 2.4],
    surfaces: ["gravel", "dirt", "cobblestone"],
    passesRange: [1, 20],
  },
];

/** Cumulative thresholds for band selection: good 55%, fair 20%, rough 15%, no_data 10%. */
function pickProfile(roll: number): BandProfile | null {
  if (roll < 0.55) return BAND_PROFILES[0] ?? null;
  if (roll < 0.75) return BAND_PROFILES[1] ?? null;
  if (roll < 0.9) return BAND_PROFILES[2] ?? null;
  return null; // no_data
}

function lerp([min, max]: [number, number], t: number): number {
  return min + (max - min) * t;
}

export function mockJoinQuality(slices: SegmentSlice[]): RouteSegment[] {
  return slices.map((slice) => {
    const rand = seededSequence(hashLineString(slice.geometry.coordinates));
    const profile = pickProfile(rand());

    if (!profile) {
      return {
        ...slice,
        band: "no_data" as const,
        surface: "unknown" as const,
        score: null,
        passes: 0,
      };
    }

    const score = Math.round(lerp(profile.scoreRange, rand()) * 10) / 10;
    const surface =
      profile.surfaces[Math.floor(rand() * profile.surfaces.length)] ??
      "asphalt";
    const passes = Math.round(lerp(profile.passesRange, rand()));

    return {
      ...slice,
      // Derive the band from the fabricated score so the two never disagree.
      band: scoreToBand(score),
      surface,
      score,
      passes,
    };
  });
}
