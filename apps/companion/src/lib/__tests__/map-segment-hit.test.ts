import type { Map as MapLibreMap, MapGeoJSONFeature, Point } from "maplibre-gl";
import { pickNearestLineFeature, readSegmentId } from "../map-segment-hit";

function feature(
  over: Partial<MapGeoJSONFeature> & {
    coords?: [number, number][];
  } = {},
): MapGeoJSONFeature {
  const { coords, ...rest } = over;
  return {
    type: "Feature",
    properties: {},
    geometry: coords
      ? { type: "LineString", coordinates: coords }
      : { type: "LineString", coordinates: [] },
    ...rest,
  } as unknown as MapGeoJSONFeature;
}

const point = (x: number, y: number) => ({ x, y }) as Point;

describe("readSegmentId", () => {
  it("prefers the promoted `id` property", () => {
    expect(readSegmentId(feature({ properties: { id: "seg-uuid" } }))).toBe(
      "seg-uuid",
    );
  });

  it("falls back to a string then a numeric feature id", () => {
    expect(readSegmentId(feature({ id: "fid" }))).toBe("fid");
    expect(readSegmentId(feature({ id: 42 }))).toBe("42");
  });

  it("returns null for a missing feature or blank id", () => {
    expect(readSegmentId(undefined)).toBeNull();
    expect(readSegmentId(feature({ properties: { id: "" } }))).toBeNull();
  });
});

describe("pickNearestLineFeature", () => {
  // A map stub whose project() maps [lng,lat] straight to screen px, so vertex
  // distance is predictable, and whose queryRenderedFeatures returns a fixed set.
  function mapStub(features: MapGeoJSONFeature[]): MapLibreMap {
    return {
      queryRenderedFeatures: () => features,
      project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
    } as unknown as MapLibreMap;
  }

  it("queries a padded box and returns the sole hit without projecting", () => {
    const boxes: unknown[] = [];
    const only = feature({ coords: [[0, 0]] });
    const map = {
      queryRenderedFeatures: (box: unknown) => {
        boxes.push(box);
        return [only];
      },
      project: () => {
        throw new Error("should not project for a single hit");
      },
    } as unknown as MapLibreMap;
    expect(pickNearestLineFeature(map, point(100, 100), ["quality"], 8)).toBe(
      only,
    );
    expect(boxes[0]).toEqual([
      [92, 92],
      [108, 108],
    ]);
  });

  it("picks the feature whose vertices run closest to the tap", () => {
    const near = feature({ coords: [[105, 105]] });
    const far = feature({
      coords: [
        [200, 200],
        [220, 210],
      ],
    });
    const map = mapStub([far, near]);
    expect(pickNearestLineFeature(map, point(100, 100), ["quality"], 8)).toBe(
      near,
    );
  });

  it("handles MultiLineString geometry", () => {
    const multi = {
      type: "Feature",
      properties: { id: "m" },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [300, 300],
            [301, 301],
          ],
          [
            [101, 101],
            [102, 102],
          ],
        ],
      },
    } as unknown as MapGeoJSONFeature;
    const other = feature({ coords: [[150, 150]] });
    const map = mapStub([multi, other]);
    expect(pickNearestLineFeature(map, point(100, 100), ["quality"], 8)).toBe(
      multi,
    );
  });
});
