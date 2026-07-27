import { render, screen } from "@testing-library/react";

const localeState = vi.hoisted(() => ({
  resolved: false,
  events: [] as string[],
}));

const readLocaleMock = vi.hoisted(() =>
  vi.fn(async () => {
    localeState.events.push("readLocale");
    localeState.resolved = true;
    return "cs";
  }),
);

const translateMock = vi.hoisted(() =>
  vi.fn((key: string) => {
    localeState.events.push(`translate:${key}`);
    return localeState.resolved ? `cs:${key}` : `en:${key}`;
  }),
);

vi.mock("@/i18n/server", () => ({
  readLocale: readLocaleMock,
  t: translateMock,
}));

import BestRoadsHubPage from "./page";

describe("BestRoadsHubPage locale binding", () => {
  beforeEach(() => {
    localeState.resolved = false;
    localeState.events.length = 0;
    vi.clearAllMocks();
  });

  it("resolves the request locale before rendering non-English copy", async () => {
    render(await BestRoadsHubPage());

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "cs:Best motorcycle roads",
      }),
    ).toBeInTheDocument();
    expect(localeState.events[0]).toBe("readLocale");
    expect(
      localeState.events
        .slice(1)
        .every((event) => event.startsWith("translate:")),
    ).toBe(true);
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/roads/best/cz?lang=cs",
    );
  });
});
