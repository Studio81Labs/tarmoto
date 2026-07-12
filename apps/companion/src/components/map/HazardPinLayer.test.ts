import type { HazardResponse } from "@/lib/api";
import {
  normalizeHazardType,
  selectHazards,
  hazardsToFeatureCollection,
  mapMarkerEmoji,
} from "./HazardPinLayer";

function hazard(over: Partial<HazardResponse> = {}): HazardResponse {
  return {
    id: "h1",
    hazard_type: "pothole",
    severity: "high",
    lat: 49,
    lng: 14,
    note: null,
    photo_url: null,
    confirmations: 2,
    reporter: "Ada",
    road_name: null,
    created_at: "2026-05-01T10:00:00.000Z",
    expires_at: null,
    ...over,
  } as unknown as HazardResponse;
}

describe("normalizeHazardType", () => {
  it("passes known types through and maps unknown to 'other'", () => {
    expect(normalizeHazardType("pothole")).toBe("pothole");
    expect(normalizeHazardType("definitely-not-a-type")).toBe("other");
  });
});

describe("selectHazards", () => {
  const list = [
    hazard({ id: "a", hazard_type: "pothole" }),
    hazard({ id: "b", hazard_type: "gravel" }),
  ];

  it("returns nothing for an empty type set", () => {
    expect(selectHazards(list, new Set())).toEqual([]);
  });

  it("filters to the active types", () => {
    const out = selectHazards(list, new Set(["pothole"] as never));
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });
});

describe("hazardsToFeatureCollection", () => {
  it("projects each hazard to a Point feature with emoji + fade opacity", () => {
    const now = Date.parse("2026-05-01T10:00:00.000Z"); // same instant → full opacity
    const fc = hazardsToFeatureCollection([hazard()], now);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0]!;
    expect(f.geometry).toEqual({ type: "Point", coordinates: [14, 49] });
    expect(f.properties.hazard_type).toBe("pothole");
    expect(typeof f.properties.emoji).toBe("string");
    expect(f.properties.opacity).toBeGreaterThan(0);
    expect(f.properties.opacity).toBeLessThanOrEqual(1);
  });

  it("normalises an unknown hazard_type to 'other'", () => {
    const fc = hazardsToFeatureCollection(
      [hazard({ hazard_type: "weird" as never })],
      Date.parse("2026-05-01T10:00:00.000Z"),
    );
    expect(fc.features[0]!.properties.hazard_type).toBe("other");
  });

  it("strips the variation selector so the emoji centres on the diamond", () => {
    // Pothole is 🕳️ = U+1F573 U+FE0F; the U+FE0F must not reach the text-field.
    const fc = hazardsToFeatureCollection([hazard()], Date.now());
    expect(fc.features[0]!.properties.emoji).not.toContain("️");
  });
});

describe("mapMarkerEmoji", () => {
  it("removes U+FE0F but keeps the base emoji glyph", () => {
    expect(mapMarkerEmoji("🕳️")).toBe("🕳");
    expect(mapMarkerEmoji("⚠️")).toBe("⚠");
    // Single-codepoint emoji are unchanged.
    expect(mapMarkerEmoji("🚧")).toBe("🚧");
  });
});
