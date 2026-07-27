import { render, screen } from "@testing-library/react";

const localeState = vi.hoisted(() => ({
  resolved: false,
  events: [] as string[],
}));

const authMock = vi.hoisted(() => vi.fn(async () => null));
const readLocaleMock = vi.hoisted(() =>
  vi.fn(async () => {
    localeState.events.push("readLocale");
    localeState.resolved = true;
    return "cs";
  }),
);

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/i18n/server", () => ({
  readLocale: readLocaleMock,
  t: (key: string) => {
    localeState.events.push(`translate:${key}`);
    return localeState.resolved ? `cs:${key}` : `en:${key}`;
  },
}));

import ExploreLayout from "./layout";
import BestRoadsLayout from "../roads/best/layout";

describe("localized public layouts", () => {
  beforeEach(() => {
    localeState.resolved = false;
    localeState.events.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "explorer",
      renderLayout: () =>
        ExploreLayout({ children: <main>explorer content</main> }),
      callbackUrl: "/explore?lang=cs",
    },
    {
      name: "best roads",
      renderLayout: () =>
        BestRoadsLayout({ children: <main>best roads content</main> }),
      callbackUrl: "/roads/best?lang=cs",
    },
  ])(
    "resolves locale before the $name header and preserves it through auth",
    async ({ renderLayout, callbackUrl }) => {
      render(await renderLayout());

      expect(localeState.events[0]).toBe("readLocale");
      expect(
        localeState.events
          .slice(1)
          .every((event) => event.startsWith("translate:")),
      ).toBe(true);
      expect(screen.getByRole("link", { name: "cs:Sign in" })).toHaveAttribute(
        "href",
        `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      );
      expect(
        screen.getByRole("link", { name: "cs:Create account" }),
      ).toHaveAttribute(
        "href",
        `/register?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      );
    },
  );
});
