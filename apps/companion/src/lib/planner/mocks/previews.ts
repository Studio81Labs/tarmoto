import { scoreToBand } from "../quality-bands";
import type { QualityBand, RoadPreview, RouteSegment } from "../types";
import { hashLineString, seededSequence } from "./hash";

/**
 * MOCK Road Preview payloads. Real Mapillary imagery and per-metre quality
 * traces aren't wired yet; this fabricates both states deterministically
 * from the segment:
 *  - measured (`hasData`): micro-strip around the segment score + a capture
 *    date for the street-level thumbnail placeholder,
 *  - no-data: an unverified OSM surface tag + capture date only.
 */

const MICRO_STRIP_BUCKETS = 10;

/** Months the fake street-level imagery may have been "captured". */
const CAPTURE_MONTHS = [
  "2023-08",
  "2023-10",
  "2024-05",
  "2024-09",
  "2025-04",
  "2025-06",
] as const;

const NO_DATA_OSM_TAGS = ["asphalt", "gravel", "paved"] as const;

function microStrip(score: number, rand: () => number): QualityBand[] {
  const strip: QualityBand[] = [];
  for (let i = 0; i < MICRO_STRIP_BUCKETS; i += 1) {
    const wobble = (rand() - 0.5) * 1.6;
    const local = Math.max(1, Math.min(5, score + wobble));
    strip.push(scoreToBand(local));
  }
  return strip;
}

export function mockRoadPreview(segment: RouteSegment): RoadPreview {
  const rand = seededSequence(
    hashLineString(segment.geometry.coordinates) ^ 0x9e3779b9,
  );
  const capturedAt =
    CAPTURE_MONTHS[Math.floor(rand() * CAPTURE_MONTHS.length)] ??
    CAPTURE_MONTHS[0];

  if (segment.band === "no_data" || segment.score == null) {
    return {
      segmentId: segment.id,
      hasData: false,
      surface: segment.surface,
      passes: 0,
      imageCapturedAt: capturedAt,
      osmSurfaceTag:
        NO_DATA_OSM_TAGS[Math.floor(rand() * NO_DATA_OSM_TAGS.length)] ??
        "asphalt",
    };
  }

  return {
    segmentId: segment.id,
    hasData: true,
    score: segment.score,
    band: segment.band,
    surface: segment.surface,
    passes: segment.passes,
    microStrip: microStrip(segment.score, rand),
    imageCapturedAt: capturedAt,
  };
}
