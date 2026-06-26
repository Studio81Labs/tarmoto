import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { App } from "./App.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";

vi.mock("../auth/adminAuthApi.js", () => ({
  adminAuthApi: {
    getCurrentAdmin: vi.fn(),
    loginWithPassword: vi.fn(),
    logout: vi.fn(),
    startGithubSso: vi.fn(),
  },
}));

vi.mock("../data/useAdminMetrics.js", () => ({
  useAdminMetrics: () => ({
    data: { users: 0, activeRides: 0, featureFlags: 0, pendingClosures: 0 },
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
});
