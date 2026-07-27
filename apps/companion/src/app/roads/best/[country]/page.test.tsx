import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "cs"),
  t: (key: string) => key,
}));

vi.mock("@/format/server", () => ({
  getServerFormatters: vi.fn(async () => ({
    month: () => "month",
  })),
}));

import BestRoadsCountryPage from "./page";

describe("BestRoadsCountryPage localized navigation", () => {
  it("keeps the request locale in hub and region links", async () => {
    render(
      await BestRoadsCountryPage({
        params: Promise.resolve({ country: "at" }),
      }),
    );

    expect(screen.getByRole("link", { name: "Best roads" })).toHaveAttribute(
      "href",
      "/roads/best?lang=cs",
    );
    expect(screen.getByRole("link", { name: /Tyrol/ })).toHaveAttribute(
      "href",
      "/roads/best/at/tyrol?lang=cs",
    );
  });
});
