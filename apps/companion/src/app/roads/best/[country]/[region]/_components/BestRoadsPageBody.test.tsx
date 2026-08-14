import { render, screen } from "@testing-library/react";
import { findCountry, findRegion } from "@tarmoto/shared";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "cs"),
  t: (key: string) => key,
}));

vi.mock("@/format/server", () => ({
  getServerFormatters: vi.fn(async () => ({
    decimal: (value: number) => String(value),
    distanceKm: (value: number) => `${value} km`,
    month: () => "month",
  })),
}));

// Capture the props actually handed ACROSS the client boundary. BestRoadsMap
// is `"use client"`, so Next serializes whatever lands here into the RSC
// Flight payload embedded in the HTML.
const mapProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./BestRoadsMap", () => ({
  BestRoadsMap: (props: unknown) => {
    mapProps.current = props;
    return <div data-testid="best-roads-map" />;
  },
}));

vi.mock("./BestRoadsList", () => ({
  BestRoadsList: () => <div data-testid="best-roads-list" />,
}));

import { BestRoadsPageBody } from "./BestRoadsPageBody";

const country = findCountry("at")!;
const region = findRegion("at", "tyrol")!;
const subRegion = findRegion("at", "alpine-passes")!;

describe("BestRoadsPageBody localized navigation", () => {
  it("keeps the request locale in breadcrumbs and sub-region drill-downs", async () => {
    const { container } = render(
      await BestRoadsPageBody({
        country,
        region,
        pageUrl: "https://tarmoto.com/roads/best/at/tyrol",
        roads: [],
      }),
    );

    expect(screen.getByRole("link", { name: "Best roads" })).toHaveAttribute(
      "href",
      "/roads/best?lang=cs",
    );
    expect(screen.getByRole("link", { name: "Austria" })).toHaveAttribute(
      "href",
      "/roads/best/at?lang=cs",
    );
    expect(screen.getByRole("link", { name: /Alpine Passes/ })).toHaveAttribute(
      "href",
      "/roads/best/at/tyrol/alpine-passes?lang=cs",
    );

    const breadcrumbs = JSON.parse(
      container.querySelectorAll('script[type="application/ld+json"]')[1]!
        .textContent!,
    );
    expect(
      breadcrumbs.itemListElement.map((item: { item: string }) => item.item),
    ).toEqual([
      "https://tarmoto.com/roads/best?lang=cs",
      "https://tarmoto.com/roads/best/at?lang=cs",
      "https://tarmoto.com/roads/best/at/tyrol?lang=cs",
    ]);
  });

  it("keeps the request locale in a sub-region parent breadcrumb", async () => {
    render(
      await BestRoadsPageBody({
        country,
        region: subRegion,
        parent: region,
        pageUrl: "https://tarmoto.com/roads/best/at/tyrol/alpine-passes",
        roads: [],
      }),
    );

    expect(screen.getByRole("link", { name: "Tyrol" })).toHaveAttribute(
      "href",
      "/roads/best/at/tyrol?lang=cs",
    );
  });
});

describe("BestRoadsPageBody — client boundary", () => {
  const road = {
    id: "seg-1",
    road_name: "Silvretta",
    road_number: null,
    curviness_score: 3.2,
    surface_type: "asphalt" as const,
    length_m: 22000,
    confidence: 0.8,
    geometry: [
      { lat: 47, lng: 10 },
      { lat: 47.1, lng: 10.1 },
    ],
  };

  it("hands no quality_score to the client map once the score is stripped", async () => {
    render(
      await BestRoadsPageBody({
        country,
        region,
        pageUrl: "https://tarmoto.com/roads/best/at/tyrol",
        roads: [road],
      }),
    );

    // The assertion the DOM cannot make: hiding the layer inside the client
    // component leaves every score in `view-source:` regardless, so check what
    // crosses the boundary rather than what renders.
    const serialized = JSON.stringify(mapProps.current);
    expect(serialized).not.toContain("quality_score");
    expect(
      (mapProps.current as { roads: object[] }).roads[0],
    ).not.toHaveProperty("quality_score");
  });

  it("does hand the score across while the flag is live", async () => {
    render(
      await BestRoadsPageBody({
        country,
        region,
        pageUrl: "https://tarmoto.com/roads/best/at/tyrol",
        roads: [{ ...road, quality_score: 4.7 }],
      }),
    );
    expect(JSON.stringify(mapProps.current)).toContain("quality_score");
  });
});
