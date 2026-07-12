import type { Map as MapLibreMap } from "maplibre-gl";
import { firstSymbolLayerId } from "./AerialBasemap";

describe("firstSymbolLayerId", () => {
  it("returns the first symbol layer — the base map's labels/POIs start here", () => {
    const map = {
      getStyle: () => ({
        layers: [
          { id: "background", type: "background" },
          { id: "water", type: "fill" },
          { id: "roads", type: "line" },
          { id: "waterway_line_label", type: "symbol" },
          { id: "poi_r7", type: "symbol" },
        ],
      }),
    } as unknown as MapLibreMap;
    expect(firstSymbolLayerId(map)).toBe("waterway_line_label");
  });

  it("is undefined when the style has no symbol layers (or none yet)", () => {
    const map = {
      getStyle: () => ({ layers: [{ id: "bg", type: "background" }] }),
    } as unknown as MapLibreMap;
    expect(firstSymbolLayerId(map)).toBeUndefined();
    const empty = { getStyle: () => undefined } as unknown as MapLibreMap;
    expect(firstSymbolLayerId(empty)).toBeUndefined();
  });
});
