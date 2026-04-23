import {
  formatRoadLabel,
  formatRoadLength,
  formatRoadQuality,
} from "../best-roads-format";

describe("best-roads-format", () => {
  it("formats road labels from name, number, or segment id", () => {
    expect(
      formatRoadLabel({
        id: "segment-123456",
        road_name: "Grossglockner High Alpine Road",
        road_number: "B107",
      }),
    ).toBe("Grossglockner High Alpine Road");

    expect(
      formatRoadLabel({
        id: "segment-123456",
        road_name: null,
        road_number: "B107",
      }),
    ).toBe("Road B107");

    expect(
      formatRoadLabel({
        id: "segment-123456",
        road_name: null,
        road_number: null,
      }),
    ).toBe("Segment segmen");
  });

  it("formats road length and quality consistently", () => {
    expect(formatRoadLength(980)).toBe("980 m");
    expect(formatRoadLength(1530)).toBe("1.5 km");
    expect(formatRoadQuality(null)).toBe("—");
    expect(formatRoadQuality(4.25)).toBe("4.3");
  });
});
