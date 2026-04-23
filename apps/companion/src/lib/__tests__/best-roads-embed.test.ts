import {
  buildBestRoadsEmbedUrl,
  buildBestRoadsIframeCode,
  projectRoadsToMiniMap,
} from "../best-roads-embed";

describe("best-roads-embed", () => {
  const roads = [
    {
      id: "road-1",
      quality_score: 4.7,
      geometry: [
        { lng: 10.1, lat: 46.1 },
        { lng: 10.3, lat: 46.2 },
        { lng: 10.5, lat: 46.35 },
      ],
    },
    {
      id: "road-2",
      quality_score: 3.4,
      geometry: [
        { lng: 10.2, lat: 46.45 },
        { lng: 10.4, lat: 46.55 },
      ],
    },
    {
      id: "road-ignored",
      quality_score: 2.1,
      geometry: [{ lng: 10.8, lat: 46.8 }],
    },
  ];

  it("builds embed urls for both region and subregion widgets", () => {
    expect(
      buildBestRoadsEmbedUrl("https://tarmoto.app", {
        country: "at",
        region: "tyrol",
        variant: "compact",
      }),
    ).toBe("https://tarmoto.app/embed/roads/at/tyrol?variant=compact");

    expect(
      buildBestRoadsEmbedUrl("https://tarmoto.app/", {
        country: "at",
        region: "tyrol",
        subregion: "alpine-passes",
        variant: "landscape",
      }),
    ).toBe(
      "https://tarmoto.app/embed/roads/at/tyrol/alpine-passes?variant=landscape",
    );
  });

  it("creates a responsive iframe snippet with the chosen widget size", () => {
    const snippet = buildBestRoadsIframeCode("https://tarmoto.app", {
      country: "at",
      region: "tyrol",
      regionName: 'Tyrol "North" & South',
    });

    expect(snippet).toContain("<iframe");
    expect(snippet).toContain(
      'src="https://tarmoto.app/embed/roads/at/tyrol?variant=compact"',
    );
    expect(snippet).toContain(
      'title="Tarmoto best roads widget for Tyrol &quot;North&quot; &amp; South"',
    );
    expect(snippet).toContain("width:100%");
    expect(snippet).toContain("height:640px");
  });

  it("uses a taller landscape iframe snippet for narrow stacked embeds", () => {
    const snippet = buildBestRoadsIframeCode("https://tarmoto.app", {
      country: "at",
      region: "tyrol",
      subregion: "alpine-passes",
      regionName: "Alpine passes",
      variant: "landscape",
    });

    expect(snippet).toContain(
      'src="https://tarmoto.app/embed/roads/at/tyrol/alpine-passes?variant=landscape"',
    );
    expect(snippet).toContain("height:640px");
  });

  it("projects only valid roads into a bounded minimap coordinate space", () => {
    const map = projectRoadsToMiniMap(roads, {
      width: 320,
      height: 180,
      padding: 16,
    });

    expect(map.viewBox).toBe("0 0 320 180");
    expect(map.lines).toHaveLength(2);
    expect(map.markers).toEqual([
      expect.objectContaining({ id: "road-1", rank: 1, color: "#22C55E" }),
      expect.objectContaining({ id: "road-2", rank: 2, color: "#EAB308" }),
    ]);

    for (const line of map.lines) {
      for (const [x, y] of line.points) {
        expect(x).toBeGreaterThanOrEqual(16);
        expect(x).toBeLessThanOrEqual(304);
        expect(y).toBeGreaterThanOrEqual(16);
        expect(y).toBeLessThanOrEqual(164);
      }
    }
  });

  it("preserves original rank numbers after invalid geometries are filtered out", () => {
    const map = projectRoadsToMiniMap(
      [
        roads[0]!,
        {
          id: "road-invalid",
          quality_score: 4.1,
          geometry: [{ lng: 10.7, lat: 46.7 }],
        },
        roads[1]!,
      ],
      {
        width: 320,
        height: 180,
        padding: 16,
      },
    );

    expect(map.markers).toEqual([
      expect.objectContaining({ id: "road-1", rank: 1 }),
      expect.objectContaining({ id: "road-2", rank: 3 }),
    ]);
  });
});
