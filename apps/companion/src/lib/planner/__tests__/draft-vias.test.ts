import { describe, expect, it } from "vitest";
import {
  draftViasThroughZones,
  funZoneCentroid,
  MAX_DRAFT_VIAS,
} from "../draft-vias";

function zone(
  id: string,
  score: number,
  center: { lat: number; lng: number },
  name: string | null = null,
) {
  return {
    id,
    name,
    composite_score: score,
    boundary: [
      { lat: center.lat + 0.1, lng: center.lng },
      { lat: center.lat - 0.1, lng: center.lng + 0.1 },
      { lat: center.lat, lng: center.lng - 0.1 },
    ],
  };
}

describe("funZoneCentroid", () => {
  it("averages the boundary ring", () => {
    const centroid = funZoneCentroid(zone("z", 1, { lat: 49, lng: 15 }));
    expect(centroid!.lat).toBeCloseTo(49, 5);
    expect(centroid!.lng).toBeCloseTo(15, 5);
  });

  it("returns null for an unusable ring", () => {
    expect(funZoneCentroid({ boundary: [] })).toBeNull();
    expect(funZoneCentroid({ boundary: [{}, { lat: "x" }] })).toBeNull();
  });

  it("drops the repeated closing vertex of a GeoJSON ring", () => {
    // A square closed with the first vertex repeated: the naive average of all
    // 5 points is (0.8, 0.8), dragged toward (0, 0). The real centre is (1, 1).
    const centroid = funZoneCentroid({
      boundary: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 2 },
        { lat: 2, lng: 2 },
        { lat: 2, lng: 0 },
        { lat: 0, lng: 0 },
      ],
    });
    expect(centroid).toEqual({ lat: 1, lng: 1 });
  });
});

describe("draftViasThroughZones", () => {
  const start = { lat: 49, lng: 14 };
  const finish = { lat: 49, lng: 17 };

  it("keeps the top-scoring zones and orders them start→finish", () => {
    const vias = draftViasThroughZones(
      [
        zone("far", 5, { lat: 49, lng: 16.5 }, "Far"),
        zone("near", 4, { lat: 49, lng: 14.5 }, "Near"),
        zone("mid", 3, { lat: 49, lng: 15.5 }, "Mid"),
        zone("skipped", 1, { lat: 49, lng: 15.0 }, "Skipped"),
      ],
      start,
      finish,
    );
    expect(vias.map((v) => v.name)).toEqual(["Near", "Mid", "Far"]);
    expect(vias).toHaveLength(MAX_DRAFT_VIAS);
  });

  it("labels unnamed zones and skips unusable boundaries", () => {
    const vias = draftViasThroughZones(
      [
        zone("a", 5, { lat: 49, lng: 15 }),
        { id: "broken", name: "X", composite_score: 9, boundary: [] },
      ],
      start,
      finish,
    );
    expect(vias).toHaveLength(1);
    expect(vias[0]!.name).toBe("Fun Zone");
  });

  it("returns nothing for no zones", () => {
    expect(draftViasThroughZones([], start, finish)).toEqual([]);
  });
});
