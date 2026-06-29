import type {
  RoadClosureReason,
  RoadClosureSeverity,
} from '../../../entities/road-closure.entity.js';

/**
 * A DATEX II situation record normalized into the `road_closures` shape,
 * decoupled from the raw XML so the reconcile pass never touches DATEX
 * structures. Produced by `Datex2ParserService`, consumed by
 * `NapReconcileService`.
 */
export interface NapSituation {
  /** Stable id from the DATEX II `situationRecord` — the upsert key. */
  externalId: string;
  /** Short human title for the closure (≤160 chars; required column). */
  title: string;
  reason: RoadClosureReason;
  severity: RoadClosureSeverity;
  /** Raw DATEX validity status passthrough, kept for debugging. */
  validityStatus: string | null;
  /** Closure window. `startsAt` falls back to the batch time if absent. */
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * GeoJSON LineString in EPSG:4326, or `null` when only Alert-C (TMC) /
   * OpenLR location codes were present and no coordinates could be
   * resolved.
   */
  geometry: { type: 'LineString'; coordinates: [number, number][] } | null;
  /** True when `geometry` is null because the location needs decoding. */
  needsLocationDecoding: boolean;
  /** Raw location reference captured for later Alert-C/OpenLR decoding. */
  rawLocationRef: unknown;
}

export interface NapReconcileResult {
  parsed: number;
  inserted: number;
  updated: number;
  deactivated: number;
  needsDecoding: number;
}

export interface NapPollStatus {
  running: boolean;
  lastRunAt: string | null;
  lastResult: NapReconcileResult | null;
  enabled: boolean;
}

export type { RoadClosureReason, RoadClosureSeverity };
