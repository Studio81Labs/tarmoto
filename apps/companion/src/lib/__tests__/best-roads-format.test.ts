import {
  formatRoadLabel,
  formatRoadLength,
  formatRoadQuality,
  formatRoadQualityColor,
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
    expect(formatRoadQualityColor(null)).toBe("#64748B");
    expect(formatRoadQualityColor(4.8)).toBe("#22C55E");
    expect(formatRoadQualityColor(3.8)).toBe("#84CC16");
    expect(formatRoadQualityColor(2.8)).toBe("#EAB308");
    expect(formatRoadQualityColor(1.8)).toBe("#F97316");
    expect(formatRoadQualityColor(1.2)).toBe("#EF4444");
  });
});
