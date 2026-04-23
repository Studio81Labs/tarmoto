import { applyTarmotoMapTheme } from "../map-style";

function createMap(layerIds: string[]) {
  return {
    getLayer: vi.fn((id: string) =>
      layerIds.includes(id) ? { id, type: "line" } : undefined,
    ),
    setPaintProperty: vi.fn(),
  };
}

describe("applyTarmotoMapTheme", () => {
  it("paints the branded light palette onto known Liberty base layers", () => {
    const map = createMap([
      "background",
      "water",
      "road_minor",
      "road_minor_casing",
      "building",
      "label_city",
      "water_name_line_label",
    ]);

    applyTarmotoMapTheme(map as never, "light");

    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "background",
      "background-color",
      "#eef5f3",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "water",
      "fill-color",
      "#9dd7f5",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "road_minor_casing",
      "line-color",
      "#cfd8dc",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "road_minor",
      "line-color",
      "#f8fafc",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "building",
      "fill-color",
      "#d9d4cb",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "label_city",
      "text-color",
      "#0f172a",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "water_name_line_label",
      "text-color",
      "#0b7285",
    );
  });

  it("switches the same layers to the dark palette without touching missing layers", () => {
    const map = createMap([
      "background",
      "water",
      "road_minor",
      "building-3d",
      "label_other",
    ]);

    applyTarmotoMapTheme(map as never, "dark");

    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "background",
      "background-color",
      "#06141d",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "water",
      "fill-color",
      "#123a52",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "road_minor",
      "line-color",
      "#475569",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "building-3d",
      "fill-extrusion-color",
      "#243244",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "label_other",
      "text-halo-color",
      "#06141d",
    );
    expect(map.setPaintProperty).not.toHaveBeenCalledWith(
      "road_minor_casing",
      expect.anything(),
      expect.anything(),
    );
  });
});
