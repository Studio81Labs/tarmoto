import { render, screen } from "@testing-library/react";
import { AppProviders } from "./AppProviders";

const mocks = vi.hoisted(() => ({
  usePathname: vi.fn(),
  sessionProvider: vi.fn(({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  )),
  authSync: vi.fn(() => <div data-testid="auth-sync" />),
  realtimeProvider: vi.fn(() => <div data-testid="realtime-provider" />),
}));

vi.mock("next/navigation", () => ({
  usePathname: mocks.usePathname,
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: mocks.sessionProvider,
}));

vi.mock("./AuthSync", () => ({
  AuthSync: mocks.authSync,
}));

vi.mock("./RealtimeProvider", () => ({
  RealtimeProvider: mocks.realtimeProvider,
}));

describe("AppProviders", () => {
  beforeEach(() => {
    mocks.usePathname.mockReset();
    mocks.sessionProvider.mockClear();
    mocks.authSync.mockClear();
    mocks.realtimeProvider.mockClear();
  });

  it("skips session and realtime providers on embed routes", () => {
    mocks.usePathname.mockReturnValue("/embed/roads/at/tyrol");

    render(
      <AppProviders>
        <div>Embed child</div>
      </AppProviders>,
    );

    expect(screen.getByText("Embed child")).toBeInTheDocument();
    expect(screen.queryByTestId("session-provider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-sync")).not.toBeInTheDocument();
    expect(screen.queryByTestId("realtime-provider")).not.toBeInTheDocument();
  });

  it("wraps regular routes with the app providers", () => {
    mocks.usePathname.mockReturnValue("/roads/best/at/tyrol");

    render(
      <AppProviders>
        <div>App child</div>
      </AppProviders>,
    );

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(screen.getByTestId("auth-sync")).toBeInTheDocument();
    expect(screen.getByTestId("realtime-provider")).toBeInTheDocument();
    expect(screen.getByText("App child")).toBeInTheDocument();
  });
});
