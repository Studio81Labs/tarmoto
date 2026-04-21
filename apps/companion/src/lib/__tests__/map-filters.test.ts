import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_FILTERS,
  FILTERABLE_SURFACES,
  HAZARD_TYPES_UI,
  QUALITY_TIERS,
  filtersEqual,
  filtersFromSearchParams,
  filtersToSearchParams,
  matchesFilters,
  type MapFilters,
} from "../map-filters";

function makeFilters(overrides: Partial<MapFilters> = {}): MapFilters {
  return {
    quality: new Set(overrides.quality ?? DEFAULT_MAP_FILTERS.quality),
    surface: new Set(overrides.surface ?? DEFAULT_MAP_FILTERS.surface),
    hazardTypes: new Set(
      overrides.hazardTypes ?? DEFAULT_MAP_FILTERS.hazardTypes,
    ),
    minCurviness: overrides.minCurviness ?? DEFAULT_MAP_FILTERS.minCurviness,
  };
}

describe("filtersToSearchParams", () => {
  it("omits params when filters match defaults", () => {
    const params = filtersToSearchParams(makeFilters());
    expect(params.toString()).toBe("");
  });

  it("serializes partial quality selection preserving canonical order", () => {
    const params = filtersToSearchParams(
      makeFilters({ quality: new Set(["good", "excellent"]) }),
    );
    expect(params.get("q")).toBe("excellent,good");
    expect(params.get("s")).toBeNull();
  });

  it("serializes partial surface selection preserving canonical order", () => {
    const params = filtersToSearchParams(
      makeFilters({ surface: new Set(["gravel", "asphalt"]) }),
    );
    expect(params.get("s")).toBe("asphalt,gravel");
    expect(params.get("q")).toBeNull();
  });

  it("serializes curviness only when non-zero", () => {
    const none = filtersToSearchParams(makeFilters({ minCurviness: 0 }));
    expect(none.get("c")).toBeNull();

    const some = filtersToSearchParams(makeFilters({ minCurviness: 42 }));
    expect(some.get("c")).toBe("42");
  });

  it("preserves unrelated params on the base", () => {
    const base = new URLSearchParams("tab=map&zoom=12");
    const params = filtersToSearchParams(
      makeFilters({ minCurviness: 30 }),
      base,
    );
    expect(params.get("tab")).toBe("map");
    expect(params.get("zoom")).toBe("12");
    expect(params.get("c")).toBe("30");
  });

  it("drops stale filter params from the base when reverting to defaults", () => {
    const base = new URLSearchParams("q=excellent&s=asphalt&c=50&tab=map");
    const params = filtersToSearchParams(makeFilters(), base);
    expect(params.get("q")).toBeNull();
    expect(params.get("s")).toBeNull();
    expect(params.get("c")).toBeNull();
    expect(params.get("tab")).toBe("map");
  });

  it("encodes empty-set selections with a sentinel, not an empty value", () => {
    const params = filtersToSearchParams(
      makeFilters({
        quality: new Set(),
        surface: new Set(),
        hazardTypes: new Set(),
      }),
    );
    expect(params.get("q")).toBe("none");
    expect(params.get("s")).toBe("none");
    expect(params.get("h")).toBe("none");
  });

  it("serializes partial hazard type selection preserving canonical order", () => {
    const params = filtersToSearchParams(
      makeFilters({ hazardTypes: new Set(["ice", "pothole"]) }),
    );
    expect(params.get("h")).toBe("pothole,ice");
    expect(params.get("q")).toBeNull();
    expect(params.get("s")).toBeNull();
  });

  it("omits hazard param when all types are selected", () => {
    const params = filtersToSearchParams(makeFilters());
    expect(params.get("h")).toBeNull();
  });
});

describe("filtersFromSearchParams", () => {
  it("returns defaults for null input", () => {
    const filters = filtersFromSearchParams(null);
    expect(filtersEqual(filters, DEFAULT_MAP_FILTERS)).toBe(true);
  });

  it("returns defaults when params are missing", () => {
    const filters = filtersFromSearchParams(new URLSearchParams());
    expect(filtersEqual(filters, DEFAULT_MAP_FILTERS)).toBe(true);
  });

  it("parses partial quality and surface selections", () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams("q=excellent,good&s=asphalt,gravel&c=25"),
    );
    expect([...filters.quality].sort()).toEqual(["excellent", "good"]);
    expect([...filters.surface].sort()).toEqual(["asphalt", "gravel"]);
    expect(filters.minCurviness).toBe(25);
  });

  it("ignores unknown values and falls back to defaults when all invalid", () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams("q=bogus&s=lava&h=dinosaur"),
    );
    expect([...filters.quality].sort()).toEqual([...QUALITY_TIERS].sort());
    expect([...filters.surface].sort()).toEqual(
      [...FILTERABLE_SURFACES].sort(),
    );
    expect([...filters.hazardTypes].sort()).toEqual(
      [...HAZARD_TYPES_UI].sort(),
    );
  });

  it("parses hazard selection and round-trips", () => {
    const original = makeFilters({
      hazardTypes: new Set(["pothole", "ice"]),
    });
    const parsed = filtersFromSearchParams(filtersToSearchParams(original));
    expect([...parsed.hazardTypes].sort()).toEqual(["ice", "pothole"]);
  });

  it("treats h=none sentinel as an empty set", () => {
    const filters = filtersFromSearchParams(new URLSearchParams("h=none"));
    expect(filters.hazardTypes.size).toBe(0);
  });

  it("keeps only valid values when mixed with unknown", () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams("q=excellent,bogus&s=asphalt,lava"),
    );
    expect([...filters.quality]).toEqual(["excellent"]);
    expect([...filters.surface]).toEqual(["asphalt"]);
  });

  it("clamps curviness to [0,100] and treats garbage as 0", () => {
    expect(
      filtersFromSearchParams(new URLSearchParams("c=-5")).minCurviness,
    ).toBe(0);
    expect(
      filtersFromSearchParams(new URLSearchParams("c=250")).minCurviness,
    ).toBe(100);
    expect(
      filtersFromSearchParams(new URLSearchParams("c=abc")).minCurviness,
    ).toBe(0);
  });

  it("round-trips through serialize → parse", () => {
    const original = makeFilters({
      quality: new Set(["fair", "poor"]),
      surface: new Set(["gravel"]),
      minCurviness: 60,
    });
    const parsed = filtersFromSearchParams(filtersToSearchParams(original));
    expect(filtersEqual(original, parsed)).toBe(true);
  });

  it("round-trips empty-set selections via the sentinel", () => {
    const original = makeFilters({
      quality: new Set(),
      surface: new Set(),
      minCurviness: 10,
    });
    const parsed = filtersFromSearchParams(filtersToSearchParams(original));
    expect(parsed.quality.size).toBe(0);
    expect(parsed.surface.size).toBe(0);
    expect(parsed.minCurviness).toBe(10);
  });

  it("treats the 'none' sentinel as an empty set", () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams("q=none&s=none"),
    );
    expect(filters.quality.size).toBe(0);
    expect(filters.surface.size).toBe(0);
  });
});

describe("matchesFilters", () => {
  const filters = makeFilters({
    quality: new Set(["excellent", "good"]),
    surface: new Set(["asphalt"]),
    minCurviness: 30,
  });

  it("passes segment that satisfies every axis", () => {
    expect(
      matchesFilters(
        { quality: "good", surface: "asphalt", curviness: 40 },
        filters,
      ),
    ).toBe(true);
  });

  it("rejects when quality tier is excluded", () => {
    expect(
      matchesFilters(
        { quality: "poor", surface: "asphalt", curviness: 40 },
        filters,
      ),
    ).toBe(false);
  });

  it("rejects when surface is excluded", () => {
    expect(
      matchesFilters(
        { quality: "good", surface: "gravel", curviness: 40 },
        filters,
      ),
    ).toBe(false);
  });

  it("rejects when curviness is below minimum", () => {
    expect(
      matchesFilters(
        { quality: "good", surface: "asphalt", curviness: 10 },
        filters,
      ),
    ).toBe(false);
  });

  it("treats unknown surface as always allowed by the surface filter", () => {
    expect(
      matchesFilters(
        { quality: "good", surface: "unknown", curviness: 50 },
        filters,
      ),
    ).toBe(true);
  });

  it("default filters accept any segment", () => {
    expect(
      matchesFilters(
        { quality: "very-poor", surface: "dirt", curviness: 0 },
        DEFAULT_MAP_FILTERS,
      ),
    ).toBe(true);
  });
});
