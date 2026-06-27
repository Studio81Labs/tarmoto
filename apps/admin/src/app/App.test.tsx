import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { App } from "./App.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";

vi.mock("../auth/adminAuthApi.js", () => ({
  adminAuthApi: {
    getConfig: vi.fn().mockResolvedValue({ passwordLoginEnabled: true }),
    getCurrentAdmin: vi.fn(),
    loginWithPassword: vi.fn(),
    logout: vi.fn(),
    startGithubSso: vi.fn(),
  },
}));

vi.mock("../data/useAdminMetrics.js", () => ({
  useAdminMetrics: () => ({
    data: { users: 0, activeRides: 0, featureFlags: 0, closures: 0 },
    isPending: false,
    error: null,
  }),
}));

function renderApp() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    (adminAuthApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      passwordLoginEnabled: true,
    });
  });

  it("shows the login screen when unauthenticated", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /github/i }),
      ).toBeInTheDocument(),
    );
  });

  it("surfaces adminAuthError from the query string when unauthenticated", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    window.history.pushState({}, "", "/?adminAuthError=sso");
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByText("GitHub sign-in failed. Please try again."),
      ).toBeInTheDocument(),
    );
    window.history.pushState({}, "", "/");
  });

  it("shows the shell + Overview when authenticated", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "a1",
      email: "ops@tarmoto.app",
      role: "admin",
      status: "active",
    });
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Overview" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("ops@tarmoto.app")).toBeInTheDocument();
  });

  it("shows password form when config resolves passwordLoginEnabled: true", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (adminAuthApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      passwordLoginEnabled: true,
    });
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in/i }),
      ).toBeInTheDocument(),
    );
  });

  it("hides password form when config resolves passwordLoginEnabled: false", async () => {
    (
      adminAuthApi.getCurrentAdmin as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (adminAuthApi.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      passwordLoginEnabled: false,
    });
    renderApp();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /github/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });
});
