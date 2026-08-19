import { Injectable } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import type {
  NapSituation,
  RoadClosureReason,
  RoadClosureSeverity,
} from './types/nap-situation.types.js';

/**
 * Parses Czech NDIC DATEX II v2.3 "common traffic information" snapshots
 * into the normalized `road_closures` shape (#743).
 *
 * ⚠️ VERIFY AGAINST A REAL PAYLOAD. DATEX II is a large, profile-specific
 * schema. The element paths below cover the common Level-A shape, but the
 * exact `xsi:type` values and how NDIC expresses a closure vs. a warning
 * vary by profile version. Once credentials exist, drop one real snapshot
 * into `test/fixtures/` and tighten the two seams that depend on the real
 * shape — everything else (reconcile, storage) is schema-agnostic:
 *   - `classifyRecord()` → `reason` / `severity` mapping
 *   - `extractGeometry()` → which location containers NDIC actually uses
 */
@Injectable()
export class Datex2ParserService {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true, // strip d2:/ns2: prefixes for stable keys
    parseTagValue: true,
    trimValues: true,
  });

  parse(xml: string): NapSituation[] {
    const root = this.parser.parse(xml) as Record<string, unknown>;

    const publication =
      this.dig(root, ['d2LogicalModel', 'payloadPublication']) ??
      this.dig(root, [
        'messageContainer',
        'payload',
        'd2LogicalModel',
        'payloadPublication',
      ]);

    // THROW (don't return []) when the `payloadPublication` element is
    // absent — a 200 that's an auth/proxy HTML page, a schema change, or
    // a wrong profile would otherwise look like a verified-empty snapshot
    // and make the reconcile pass deactivate every official closure. The
    // poller catches this and skips reconcile. A *present but empty*
    // publication (`payloadPublication` with zero situations, which
    // fast-xml-parser yields as '') is a real empty feed → returns [].
    if (publication == null) {
      throw new Error(
        'Unrecognized NAP snapshot: no payloadPublication envelope ' +
          '(auth/proxy HTML, schema change, or unexpected profile?)',
      );
    }

    const out: NapSituation[] = [];
    for (const situation of this.asArray(
      typeof publication === 'object'
        ? (publication as Record<string, unknown>).situation
        : undefined,
    )) {
      const sit = situation as Record<string, unknown>;
      for (const rec of this.asArray(sit.situationRecord)) {
        const parsed = this.parseRecord(rec as Record<string, unknown>, sit);
        if (parsed) out.push(parsed);
      }
    }
    return out;
  }

  private parseRecord(
    rec: Record<string, unknown>,
    situation: Record<string, unknown>,
  ): NapSituation | null {
    const externalId = (rec['@_id'] ?? situation['@_id']) as
      string | number | undefined;
    if (externalId == null) return null;

    const rawType = (rec['@_type'] ?? rec['@_xsi:type'] ?? null) as
      string | null;
    const { reason, severity } = this.classifyRecord(rec, rawType);

    const validity = (this.dig(rec, ['validity']) ?? {}) as Record<
      string,
      unknown
    >;
    const timeSpec = (this.dig(validity, ['validityTimeSpecification']) ??
      {}) as Record<string, unknown>;

    const { geometry, needsLocationDecoding, rawLocationRef } =
      this.extractGeometry(rec);

    const comment = this.extractComment(rec);

    return {
      externalId: String(externalId),
      title: this.deriveTitle(comment, reason),
      reason,
      severity,
      validityStatus:
        typeof validity.validityStatus === 'string'
          ? validity.validityStatus
          : null,
      startsAt: this.toDate(timeSpec.overallStartTime),
      endsAt: this.toDate(timeSpec.overallEndTime),
      geometry,
      needsLocationDecoding,
      rawLocationRef,
    };
  }

  /**
   * Map a DATEX record to the `road_closures` `reason` + `severity`.
   * Intentionally permissive — TUNE against real NDIC payloads.
   */
  private classifyRecord(
    rec: Record<string, unknown>,
    rawType: string | null,
  ): { reason: RoadClosureReason; severity: RoadClosureSeverity } {
    const type = (rawType ?? '').toLowerCase();
    const text = this.collectStrings(rec).join(' ').toLowerCase();
    const isLaneRestriction =
      /\b(lane|laneclosures|carriagewayrestriction|narrowlanes|contraflow)\b/.test(
        text,
      );
    // An unambiguous whole-road closure. The generic `closed`/`closure`
    // tokens only count when there's NO lane cue — otherwise "right lane
    // closed" would be mis-ranked as a full closure (over actual full
    // closures) in /closures/check-route counts.
    const isFullClosure =
      /\b(carriagewayclosed|roadclosed|carriagewayclosures)\b/.test(text) ||
      (!isLaneRestriction && /\b(closed|closure)\b/.test(text));

    const severityFor = (
      fallback: RoadClosureSeverity,
    ): RoadClosureSeverity => {
      if (isFullClosure) return 'full';
      if (isLaneRestriction) return 'partial';
      return fallback;
    };

    if (type.includes('accident')) {
      return { reason: 'event', severity: severityFor('advisory') };
    }
    if (
      type.includes('roadworks') ||
      type.includes('constructionworks') ||
      type.includes('maintenanceworks')
    ) {
      return { reason: 'roadworks', severity: severityFor('partial') };
    }
    if (type.includes('weather') || type.includes('environmental')) {
      return { reason: 'weather', severity: severityFor('advisory') };
    }
    if (
      type.includes('obstruction') ||
      type.includes('animal') ||
      type.includes('vehicleobstruction')
    ) {
      return { reason: 'event', severity: severityFor('advisory') };
    }
    if (isFullClosure) {
      return { reason: 'closure', severity: 'full' };
    }
    if (type.includes('networkmanagement') || isLaneRestriction) {
      return { reason: 'other', severity: severityFor('partial') };
    }
    return { reason: 'other', severity: 'advisory' };
  }

  /**
   * Extract a GeoJSON LineString. Coordinate-based point/linear locations
   * are parsed directly; Alert-C (TMC) / OpenLR-only locations have no
   * coordinates and are flagged for later decoding (geometry = null).
   */
  private extractGeometry(rec: Record<string, unknown>): {
    geometry: NapSituation['geometry'];
    needsLocationDecoding: boolean;
    rawLocationRef: unknown;
  } {
    const group =
      this.dig(rec, ['groupOfLocations']) ?? this.dig(rec, ['location']) ?? rec;

    // 1) Linear element as an ordered coordinate list (preferred).
    const line = this.coordsFromLineString(
      this.findFirst(group, 'gmlLineString') ??
        this.findFirst(group, 'coordinatesList'),
    );
    if (line && line.length >= 2) {
      return {
        geometry: { type: 'LineString', coordinates: line },
        needsLocationDecoding: false,
        rawLocationRef: null,
      };
    }

    // 2) Linear-by-coordinates extension (DATEX v2.3 roadworks shape):
    //    explicit start + end points. Handle this BEFORE the single-point
    //    fallback, which would otherwise grab only the start point's
    //    `pointCoordinates` and store a zero-length line covering one end
    //    of the closed stretch.
    const start = this.pointFromContainer(
      this.findFirst(group, 'linearCoordinatesStartPoint'),
    );
    const end = this.pointFromContainer(
      this.findFirst(group, 'linearCoordinatesEndPoint'),
    );
    if (start && end) {
      return {
        geometry: { type: 'LineString', coordinates: [start, end] },
        needsLocationDecoding: false,
        rawLocationRef: null,
      };
    }

    // 3) Single point by coordinates → degenerate 2-point line so it can
    //    still be stored as a LineString (the column type) and buffered.
    const pt = this.pointFromContainer(group);
    if (pt) {
      return {
        geometry: { type: 'LineString', coordinates: [pt, pt] },
        needsLocationDecoding: false,
        rawLocationRef: null,
      };
    }

    // 4) Alert-C / OpenLR only → store, flag for decoding.
    const alertC =
      this.findFirst(group, 'alertCLinear') ??
      this.findFirst(group, 'alertCPoint');
    const openlr =
      this.findFirst(group, 'openlrExtendedLinear') ??
      this.findFirst(group, 'openlr');
    return {
      geometry: null,
      needsLocationDecoding: true,
      rawLocationRef: alertC ?? openlr ?? null,
    };
  }

  /**
   * Find the first `pointCoordinates` (lat/lon) anywhere inside a
   * container and return it as a GeoJSON `[lon, lat]` pair, or null.
   */
  private pointFromContainer(node: unknown): [number, number] | null {
    if (node == null || typeof node !== 'object') return null;
    const pc = this.findFirst(node, 'pointCoordinates') as
      Record<string, unknown> | undefined;
    if (pc && pc.latitude != null && pc.longitude != null) {
      return [Number(pc.longitude), Number(pc.latitude)];
    }
    return null;
  }

  private coordsFromLineString(node: unknown): [number, number][] | null {
    if (!node || typeof node !== 'object') return null;
    const n = node as Record<string, unknown>;

    // GML posList: "lat lon [height] lat lon [height] ..." → GeoJSON wants
    // [lon, lat]. Tuples are `srsDimension` wide (default 2); a 3D posList
    // (`lat lon height`) must be stepped by 3 or the height bleeds into
    // the next point's lat/lon and the closure lands in the wrong place.
    const { text, dim } = this.readPosList(n);
    if (text !== null) {
      const nums = text.trim().split(/\s+/).map(Number);
      const out: [number, number][] = [];
      for (let i = 0; i + 1 < nums.length; i += dim) {
        const lat = nums[i];
        const lon = nums[i + 1];
        if (lat === undefined || lon === undefined) continue;
        out.push([lon, lat]);
      }
      return out.length ? out : null;
    }

    const points = this.asArray(n.pointCoordinates)
      .map((p) => p as Record<string, unknown>)
      .filter((p) => p?.latitude != null && p?.longitude != null)
      .map(
        (p) => [Number(p.longitude), Number(p.latitude)] as [number, number],
      );
    return points.length ? points : null;
  }

  /**
   * Extract the posList text and its `srsDimension` (tuple width). The
   * attribute can sit on the LineString node or on the posList element
   * itself (fast-xml-parser turns `<posList srsDimension="3">…` into
   * `{ '@_srsDimension': '3', '#text': '…' }`). Defaults to 2.
   */
  private readPosList(n: Record<string, unknown>): {
    text: string | null;
    dim: number;
  } {
    const parseDim = (v: unknown): number | null => {
      const d =
        typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
      return Number.isInteger(d) && d >= 2 ? d : null;
    };
    const nodeDim = parseDim(n['@_srsDimension']);

    const posList = n.posList;
    if (typeof posList === 'string') {
      return { text: posList, dim: nodeDim ?? 2 };
    }
    if (posList && typeof posList === 'object') {
      const p = posList as Record<string, unknown>;
      return {
        text: typeof p['#text'] === 'string' ? p['#text'] : null,
        dim: parseDim(p['@_srsDimension']) ?? nodeDim ?? 2,
      };
    }
    // The node itself may be the posList element (text + attribute).
    if (typeof n['#text'] === 'string') {
      return { text: n['#text'], dim: nodeDim ?? 2 };
    }
    return { text: null, dim: nodeDim ?? 2 };
  }

  private extractComment(rec: Record<string, unknown>): string | null {
    const comment =
      this.findFirst(rec, 'generalPublicComment') ??
      this.findFirst(rec, 'nonGeneralPublicComment') ??
      this.findFirst(rec, 'comment');
    if (!comment) return null;
    const values = this.asArray(
      this.dig(comment as Record<string, unknown>, [
        'comment',
        'values',
        'value',
      ]) ?? this.dig(comment as Record<string, unknown>, ['values', 'value']),
    );
    const first = values.find(
      (v) =>
        typeof v === 'string' ||
        (v != null && typeof v === 'object' && '#text' in v),
    );
    if (first == null) return null;
    if (typeof first === 'string') return first;
    const text = (first as Record<string, unknown>)['#text'];
    return typeof text === 'string' ? text : null;
  }

  private deriveTitle(
    comment: string | null,
    reason: RoadClosureReason,
  ): string {
    const base = (comment ?? this.titleForReason(reason)).trim();
    return base.length > 160 ? base.slice(0, 157) + '…' : base || 'Road event';
  }

  private titleForReason(reason: RoadClosureReason): string {
    const labels: Record<RoadClosureReason, string> = {
      closure: 'Road closure',
      roadworks: 'Roadworks',
      seasonal: 'Seasonal closure',
      weather: 'Weather event',
      event: 'Traffic incident',
      other: 'Road restriction',
    };
    return labels[reason];
  }

  // ── generic helpers ──

  private asArray<T = unknown>(v: T | T[] | undefined | null): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }

  private dig(obj: unknown, path: string[]): unknown {
    return path.reduce<unknown>(
      (acc, key) =>
        acc != null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
  }

  /** Depth-first search for the first occurrence of a key. */
  private findFirst(obj: unknown, key: string, depth = 6): unknown {
    if (obj == null || typeof obj !== 'object' || depth < 0) return undefined;
    const o = obj as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const found = this.findFirst(v, key, depth - 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /** Collect all string + attribute values for closure keyword scanning. */
  private collectStrings(obj: unknown, depth = 6): string[] {
    if (obj == null || depth < 0) return [];
    if (typeof obj === 'string') return [obj];
    if (typeof obj !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k.startsWith('@_')) out.push(String(v));
      else out.push(...this.collectStrings(v, depth - 1));
    }
    return out;
  }

  private toDate(v: unknown): Date | null {
    if (v == null) return null;
    const raw =
      typeof v === 'string'
        ? v
        : typeof v === 'object' && '#text' in (v as Record<string, unknown>)
          ? String((v as Record<string, unknown>)['#text'])
          : '';
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
