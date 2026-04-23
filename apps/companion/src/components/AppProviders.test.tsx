import { render, screen } from "@testing-library/react";
import { AppProviders } from "./AppProviders";

const mocks = vi.hoisted(() => ({
  usePathname: vi.fn(),
  authenticatedProviders: vi.fn(
    ({ children }: { children: React.ReactNode }) => {
      return <div data-testid="authenticated-providers">{children}</div>;
    },
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: mocks.usePathname,
}));

vi.mock("next/dynamic", () => ({
  default: () => mocks.authenticatedProviders,
}));

describe("AppProviders", () => {
  beforeEach(() => {
    mocks.usePathname.mockReset();
    mocks.authenticatedProviders.mockClear();
  });

  it("skips session and realtime providers on embed routes", () => {
    mocks.usePathname.mockReturnValue("/embed/roads/at/tyrol");

    render(
      <AppProviders>
        <div>Embed child</div>
      </AppProviders>,
    );

    expect(screen.getByText("Embed child")).toBeInTheDocument();
    expect(
      screen.queryByTestId("authenticated-providers"),
    ).not.toBeInTheDocument();
  });

  it("keeps providers enabled for non-embed routes with a similar prefix", () => {
    mocks.usePathname.mockReturnValue("/embeddings");

    render(
      <AppProviders>
        <div>Similar prefix child</div>
      </AppProviders>,
    );

    expect(screen.getByTestId("authenticated-providers")).toBeInTheDocument();
    expect(screen.getByText("Similar prefix child")).toBeInTheDocument();
  });

  it("wraps regular routes with the app providers", () => {
    mocks.usePathname.mockReturnValue("/roads/best/at/tyrol");

    render(
      <AppProviders>
        <div>App child</div>
      </AppProviders>,
    );

    expect(screen.getByTestId("authenticated-providers")).toBeInTheDocument();
    expect(screen.getByText("App child")).toBeInTheDocument();
  });
});
