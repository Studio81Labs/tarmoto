import {
  applyHazardAlert,
  BELOW_THRESHOLD_OPACITY,
  bboxFromVisibleBounds,
  buildQualityLineStyle,
  DEV_MAP_STYLE_URL,
  FUN_ZONE_COLORS,
  FUN_ZONE_SCORE_BREAKS,
  funZoneFillStyle,
  funZoneLineStyle,
  funZonesToFeatureCollection,
  HAZARD_SEVERITY_COLORS,
  hazardsToFeatureCollection,
  hazardMarkerStyle,
  PASS_STATUS_COLORS,
  QUALITY_STEP_BREAKS,
  getQualityTileUrlTemplate,
  passMarkerStyle,
  passesToFeatureCollection,
  qualityLineStyle,
} from "../MapScreen.helpers";
import { colors } from "@/theme";
import type {
  FunZone,
  Hazard,
  HazardAlertEvent,
  LatLng,
  MountainPass,
} from "@/types";

function makePass(overrides: Partial<MountainPass> = {}): MountainPass {
  return {
    id: "pass-1",
    name: "Test Pass",
    country_code: "AT",
    region: "Tyrol",
    lat: 47.1,
    lng: 11.5,
    elevation_m: 2000,
    typical_open_month: 6,
    typical_close_month: 10,
    status: "open",
    status_overridden: false,
    notes: null,
    last_updated: "2026-04-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("getQualityTileUrlTemplate", () => {
  it("appends the MVT tile path to the given api base", () => {
    expect(getQualityTileUrlTemplate("http://localhost:3000/v1")).toBe(
      "http://localhost:3000/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality",
    );
    expect(getQualityTileUrlTemplate("https://api.tarmoto.app/v1")).toBe(
      "https://api.tarmoto.app/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality",
    );
  });

  it("keeps xyz placeholders unsubstituted so MapLibre can fill them", () => {
    const template = getQualityTileUrlTemplate("http://localhost:3000/v1");
    expect(template).toContain("{z}");
    expect(template).toContain("{x}");
    expect(template).toContain("{y}");
  });

  it("requests only the quality MVT layer (hazards/surface are separate features)", () => {
    expect(getQualityTileUrlTemplate("http://localhost:3000/v1")).toContain(
      "layers=quality",
    );
  });
});

describe("qualityLineStyle", () => {
  it("uses theme quality colours in ascending-score order", () => {
    // step: default, t1, c1, t2, c2, t3, c3, t4, c4
    const expr = qualityLineStyle.lineColor as unknown as unknown[];
    expect(expr[0]).toBe("step");
    expect(expr[2]).toBe(colors.quality.veryPoor);
    expect(expr[3]).toBe(QUALITY_STEP_BREAKS[0]);
    expect(expr[4]).toBe(colors.quality.poor);
    expect(expr[5]).toBe(QUALITY_STEP_BREAKS[1]);
    expect(expr[6]).toBe(colors.quality.fair);
    expect(expr[7]).toBe(QUALITY_STEP_BREAKS[2]);
    expect(expr[8]).toBe(colors.quality.good);
    expect(expr[9]).toBe(QUALITY_STEP_BREAKS[3]);
    expect(expr[10]).toBe(colors.quality.excellent);
  });

  it("reads quality_score from the vector-tile feature", () => {
    const expr = qualityLineStyle.lineColor as unknown as unknown[];
    expect(expr[1]).toEqual(["get", "quality_score"]);
  });

  it("keeps step thresholds sorted and matching theme half-point buckets", () => {
    // theme.qualityColor() bucketing: ≥4.5 excellent, ≥3.5 good, ≥2.5 fair,
    // ≥1.5 poor, else very poor. The step expression fires the color for a
    // threshold when `quality_score >= threshold`, so the same breaks apply.
    expect(QUALITY_STEP_BREAKS).toEqual([1.5, 2.5, 3.5, 4.5]);
    const sorted = [...QUALITY_STEP_BREAKS].sort((a, b) => a - b);
    expect(sorted).toEqual([...QUALITY_STEP_BREAKS]);
  });

  it("scales line width with zoom so roads stay visible at every level", () => {
    const expr = qualityLineStyle.lineWidth as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["zoom"]);
    // At country zoom roads are thin; at street zoom they're thick.
    // Pair layout: [..., stop1, w1, stop2, w2, ...]
    const widthAt8 = expr[4] as number;
    const widthAt20 = expr[10] as number;
    expect(widthAt20).toBeGreaterThan(widthAt8);
  });

  it("fades segments with low confidence via lineOpacity (0-100 scale per backend DTO)", () => {
    const expr = qualityLineStyle.lineOpacity as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["get", "confidence"]);
    // Backend serves confidence as an int 0-100 ("0-100, based on number of
    // readings" — see road-segment.dto.ts). Stops must match that range.
    const [, , , lowerStop, opacityAtLow, upperStop, opacityAtHigh] = expr as [
      string,
      unknown,
      unknown,
      number,
      number,
      number,
      number,
    ];
    expect(lowerStop).toBe(0);
    expect(upperStop).toBe(100);
    expect(opacityAtLow).toBeLessThan(opacityAtHigh);
    expect(opacityAtHigh).toBe(1);
  });
});

describe("DEV_MAP_STYLE_URL", () => {
  it("uses the MapLibre public demotiles style until a Tarmoto basemap ships", () => {
    expect(DEV_MAP_STYLE_URL).toMatch(/^https:\/\/demotiles\.maplibre\.org\//);
  });
});

describe("buildQualityLineStyle (US-5 minimum-quality filter)", () => {
  it("returns the baseline style unchanged when the threshold is at the floor", () => {
    // minQuality = 1 means "show everything" — no filter should be applied
    // so the lineColor stays a plain `step` expression (the MapLibre style
    // diff stays cheap and nothing is grayed out).
    expect(buildQualityLineStyle(1)).toBe(qualityLineStyle);
  });

  it("wraps the color expression in a case so below-threshold segments go gray", () => {
    const style = buildQualityLineStyle(3);
    const expr = style.lineColor as unknown as unknown[];
    expect(expr[0]).toBe("case");
    // Condition: quality_score < (minQuality - 0.5) = 2.5
    expect(expr[1]).toEqual(["<", ["get", "quality_score"], 2.5]);
    // Gray fill for segments below threshold.
    expect(expr[2]).toBe(colors.textTertiary);
    // Fallback: the baseline step expression untouched.
    expect(expr[3]).toBe(qualityLineStyle.lineColor);
  });

  it("fades below-threshold segments via lineOpacity case", () => {
    const style = buildQualityLineStyle(4);
    const expr = style.lineOpacity as unknown as unknown[];
    expect(expr[0]).toBe("case");
    // minQuality 4 → below-threshold = quality_score < 3.5
    expect(expr[1]).toEqual(["<", ["get", "quality_score"], 3.5]);
    expect(expr[2]).toBe(BELOW_THRESHOLD_OPACITY);
    // Fallback keeps the confidence-driven opacity for qualifying segments.
    expect(expr[3]).toBe(qualityLineStyle.lineOpacity);
  });

  it("keeps line width, cap, and join from the baseline style", () => {
    const style = buildQualityLineStyle(5);
    expect(style.lineWidth).toBe(qualityLineStyle.lineWidth);
    expect(style.lineCap).toBe(qualityLineStyle.lineCap);
    expect(style.lineJoin).toBe(qualityLineStyle.lineJoin);
  });

  it("uses half-point bucket boundaries to match qualityLabel buckets", () => {
    // A 2.8-scored road labels as "Fair" (qualityLabel uses ≥ 2.5), so a
    // "Fair or better" filter (minQuality 3) must treat it as qualifying.
    // The filter threshold is minQuality - 0.5, not minQuality itself.
    for (const minQ of [2, 3, 4, 5] as const) {
      const style = buildQualityLineStyle(minQ);
      const expr = style.lineColor as unknown as unknown[];
      const condition = expr[1] as unknown[];
      expect(condition[2]).toBe(minQ - 0.5);
    }
  });
});

describe("passesToFeatureCollection", () => {
  it("emits a FeatureCollection with one Point per pass and status carried on properties", () => {
    const fc = passesToFeatureCollection([
      makePass({ id: "a", status: "open", lng: 10, lat: 46 }),
      makePass({ id: "b", status: "closed", lng: 11, lat: 47 }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({
      type: "Point",
      coordinates: [10, 46],
    });
    expect(fc.features[0].properties).toEqual({ id: "a", status: "open" });
    expect(fc.features[1].properties.status).toBe("closed");
  });

  it("returns an empty collection for an empty input (avoids ShapeSource errors)", () => {
    const fc = passesToFeatureCollection([]);
    expect(fc.features).toEqual([]);
  });
});

describe("passMarkerStyle", () => {
  it("matches each PassStatus to its theme colour with unknown as fallback", () => {
    const expr = passMarkerStyle.circleColor as unknown as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "status"]);
    expect(expr[2]).toBe("open");
    expect(expr[3]).toBe(PASS_STATUS_COLORS.open);
    expect(expr[4]).toBe("closed");
    expect(expr[5]).toBe(PASS_STATUS_COLORS.closed);
    // Final element of `match` is the fallback — must be the unknown colour.
    expect(expr[expr.length - 1]).toBe(PASS_STATUS_COLORS.unknown);
  });

  it("uses theme colours for the three statuses (no hardcoded hex drift)", () => {
    expect(PASS_STATUS_COLORS.open).toBe(colors.success);
    expect(PASS_STATUS_COLORS.closed).toBe(colors.danger);
    expect(PASS_STATUS_COLORS.unknown).toBe(colors.textTertiary);
  });

  it("scales marker radius with zoom so passes are visible at country level", () => {
    const expr = passMarkerStyle.circleRadius as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["zoom"]);
    const radiusAtLowZoom = expr[4] as number;
    const radiusAtHighZoom = expr[expr.length - 1] as number;
    expect(radiusAtHighZoom).toBeGreaterThan(radiusAtLowZoom);
  });
});

// ── US-6 Fun Zones ──────────────────────────────────────────────────────────

function makeSquareBoundary(
  centerLat: number,
  centerLng: number,
  size = 0.1,
): LatLng[] {
  const half = size / 2;
  // Explicitly unclosed — the helper is expected to close it for us.
  return [
    { lat: centerLat - half, lng: centerLng - half },
    { lat: centerLat - half, lng: centerLng + half },
    { lat: centerLat + half, lng: centerLng + half },
    { lat: centerLat + half, lng: centerLng - half },
  ];
}

function makeFunZone(overrides: Partial<FunZone> = {}): FunZone {
  return {
    id: "zone-1",
    name: "Beskydy loop",
    composite_score: 4.2,
    road_count: 12,
    total_curve_km: 48.5,
    avg_quality: 4.1,
    best_season: "summer",
    boundary: makeSquareBoundary(49.5, 18.3),
    ...overrides,
  };
}

describe("bboxFromVisibleBounds", () => {
  it("emits west,south,east,north ordered regardless of the corner order", () => {
    // MapLibre 10.x hands over `[[east, north], [west, south]]`; older
    // builds swapped them. The helper must normalise either orientation.
    expect(
      bboxFromVisibleBounds([
        [18.4, 49.6],
        [18.2, 49.4],
      ]),
    ).toBe("18.2,49.4,18.4,49.6");
    expect(
      bboxFromVisibleBounds([
        [18.2, 49.4],
        [18.4, 49.6],
      ]),
    ).toBe("18.2,49.4,18.4,49.6");
  });

  it("rounds to 4 decimals so tiny camera jitter yields a stable bbox", () => {
    // Two near-identical viewports should collapse to the same bbox so the
    // fetch cache key (see MapScreen.lastFunZoneBboxRef) doesn't thrash.
    const a = bboxFromVisibleBounds([
      [18.20001, 49.40002],
      [18.39999, 49.59999],
    ]);
    const b = bboxFromVisibleBounds([
      [18.20004, 49.4],
      [18.4, 49.6],
    ]);
    expect(a).toBe(b);
  });
});

describe("funZonesToFeatureCollection", () => {
  it("emits a FeatureCollection with one Polygon per zone and a closed ring", () => {
    const fc = funZonesToFeatureCollection([
      makeFunZone({ id: "a" }),
      makeFunZone({ id: "b", composite_score: 3.1 }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.type).toBe("Polygon");
    const ring = fc.features[0].geometry.coordinates[0];
    // 4 unique vertices + explicit close → 5 entries in the output ring.
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("carries zone metadata on feature properties so the tap handler can look it up", () => {
    const zone = makeFunZone({
      id: "meta",
      composite_score: 4.7,
      road_count: 9,
      total_curve_km: 22.3,
      avg_quality: 4.5,
      best_season: "summer",
      name: "Custom zone",
    });
    const fc = funZonesToFeatureCollection([zone]);
    expect(fc.features[0].properties).toEqual({
      id: "meta",
      name: "Custom zone",
      composite_score: 4.7,
      road_count: 9,
      total_curve_km: 22.3,
      avg_quality: 4.5,
      best_season: "summer",
    });
  });

  it("outputs [lng, lat] tuples as GeoJSON requires (not [lat, lng])", () => {
    const fc = funZonesToFeatureCollection([
      makeFunZone({
        boundary: [
          { lat: 10, lng: 20 },
          { lat: 10, lng: 21 },
          { lat: 11, lng: 21 },
          { lat: 11, lng: 20 },
        ],
      }),
    ]);
    const first = fc.features[0].geometry.coordinates[0][0];
    expect(first).toEqual([20, 10]);
  });

  it("drops degenerate zones with fewer than three unique vertices", () => {
    const fc = funZonesToFeatureCollection([
      makeFunZone({
        id: "degenerate",
        boundary: [
          { lat: 10, lng: 20 },
          { lat: 10, lng: 21 },
        ],
      }),
      makeFunZone({ id: "ok" }),
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.id).toBe("ok");
  });

  it("returns an empty collection for an empty input (avoids ShapeSource errors)", () => {
    const fc = funZonesToFeatureCollection([]);
    expect(fc.features).toEqual([]);
  });

  it("normalises nullable metadata to null rather than undefined", () => {
    // The backend DTO already uses null for missing name/curve/season, but
    // mobile code sometimes coerces to undefined — make sure the helper
    // hands feature properties that MapLibre can diff without surprises.
    const fc = funZonesToFeatureCollection([
      makeFunZone({
        name: null,
        total_curve_km: null,
        avg_quality: null,
        best_season: null,
      }),
    ]);
    const props = fc.features[0].properties;
    expect(props.name).toBeNull();
    expect(props.total_curve_km).toBeNull();
    expect(props.avg_quality).toBeNull();
    expect(props.best_season).toBeNull();
  });
});

describe("funZoneFillStyle / funZoneLineStyle", () => {
  it("reuses the quality colour ramp so fun zones read with the same semantics", () => {
    // A 4.5+ fun zone must show in the same excellent-green as a 4.5+ road
    // segment — keeps the visual contract across every score surface.
    expect(FUN_ZONE_COLORS).toEqual({
      veryPoor: colors.quality.veryPoor,
      poor: colors.quality.poor,
      fair: colors.quality.fair,
      good: colors.quality.good,
      excellent: colors.quality.excellent,
    });
    expect(FUN_ZONE_SCORE_BREAKS).toEqual(QUALITY_STEP_BREAKS);
  });

  it("applies a step colour expression keyed on composite_score", () => {
    const fillExpr = funZoneFillStyle.fillColor as unknown as unknown[];
    expect(fillExpr[0]).toBe("step");
    expect(fillExpr[1]).toEqual(["get", "composite_score"]);
    expect(fillExpr[2]).toBe(FUN_ZONE_COLORS.veryPoor);
    expect(fillExpr[fillExpr.length - 1]).toBe(FUN_ZONE_COLORS.excellent);
    const lineExpr = funZoneLineStyle.lineColor as unknown as unknown[];
    expect(lineExpr[0]).toBe("step");
    expect(lineExpr[1]).toEqual(["get", "composite_score"]);
  });

  it("fades the fill out at high zoom so individual roads stay readable", () => {
    // Heatmap vibes at country zoom; at street level the layer is nearly
    // transparent so quality-overlay lines show through.
    const expr = funZoneFillStyle.fillOpacity as unknown as unknown[];
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["zoom"]);
    const opacityAtLowZoom = expr[4] as number;
    const opacityAtHighZoom = expr[expr.length - 1] as number;
    expect(opacityAtLowZoom).toBeGreaterThan(opacityAtHighZoom);
  });
});

// ── #341 Hazard helpers ──

function makeHazard(overrides: Partial<Hazard> = {}): Hazard {
  return {
    id: "h-1",
    lat: 49.8,
    lng: 18.2,
    hazard_type: "pothole",
    severity: "medium",
    note: null,
    photo_url: null,
    confirmations: 0,
    reporter: null,
    road_name: null,
    created_at: "2026-05-02T10:00:00.000Z",
    expires_at: "2026-05-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("hazardsToFeatureCollection", () => {
  it("emits one Point feature per hazard with severity + type on properties", () => {
    const fc = hazardsToFeatureCollection([
      makeHazard({ id: "a", severity: "high", hazard_type: "ice" }),
      makeHazard({ id: "b", severity: "low", hazard_type: "gravel" }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.properties).toEqual({
      id: "a",
      severity: "high",
      hazard_type: "ice",
    });
    expect(fc.features[0]?.geometry).toEqual({
      type: "Point",
      coordinates: [18.2, 49.8],
    });
  });

  it("handles an empty list without throwing", () => {
    expect(hazardsToFeatureCollection([]).features).toEqual([]);
  });
});

describe("hazardMarkerStyle", () => {
  it("data-drives circleColor off the severity property", () => {
    const expr = hazardMarkerStyle.circleColor as unknown as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "severity"]);
    expect(expr).toContain(HAZARD_SEVERITY_COLORS.high);
    expect(expr).toContain(HAZARD_SEVERITY_COLORS.medium);
    expect(expr).toContain(HAZARD_SEVERITY_COLORS.low);
  });
});

describe("applyHazardAlert", () => {
  it("appends a hazard the local list doesn't yet have", () => {
    const list: Hazard[] = [makeHazard({ id: "old" })];
    const event: HazardAlertEvent = makeHazard({ id: "new" });
    const next = applyHazardAlert(list, event);
    expect(next).toHaveLength(2);
    expect(next.map((h) => h.id)).toEqual(["old", "new"]);
  });

  it("replaces an existing hazard by id (covers the confirm rebroadcast path)", () => {
    const list: Hazard[] = [makeHazard({ id: "h1", confirmations: 0 })];
    const event: HazardAlertEvent = makeHazard({ id: "h1", confirmations: 3 });
    const next = applyHazardAlert(list, event);
    expect(next).toHaveLength(1);
    expect(next[0]?.confirmations).toBe(3);
  });

  it("removes a hazard when the wire severity is 'dismissed'", () => {
    const list: Hazard[] = [
      makeHazard({ id: "keep" }),
      makeHazard({ id: "drop" }),
    ];
    const event = {
      ...makeHazard({ id: "drop" }),
      severity: "dismissed" as const,
    };
    const next = applyHazardAlert(list, event);
    expect(next.map((h) => h.id)).toEqual(["keep"]);
  });

  it("preserves referential equality when nothing changes", () => {
    const list: Hazard[] = [makeHazard({ id: "h1" })];
    const event = {
      ...makeHazard({ id: "absent" }),
      severity: "dismissed" as const,
    };
    expect(applyHazardAlert(list, event)).toBe(list);
  });
});
