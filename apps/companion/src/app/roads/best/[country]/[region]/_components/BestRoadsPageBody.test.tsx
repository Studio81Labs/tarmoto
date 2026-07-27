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

vi.mock("./BestRoadsMap", () => ({
  BestRoadsMap: () => <div data-testid="best-roads-map" />,
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
