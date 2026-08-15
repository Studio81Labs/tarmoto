import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// KEYED: this layout gates the whole `/community/*` tree on one kill switch,
// and the pages beneath it read others (`sys_gamification`,
// `sys_community_collections`). A key-blind mock would let a gate on the wrong
// one pass (#1204).
const killSwitches = vi.hoisted(
  () => ({ community_access: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import CommunityLayout from "./layout";

describe("CommunityLayout — community_access", () => {
  beforeEach(() => {
    killSwitches.community_access = true;
  });

  it("renders the tree while the switch is live", () => {
    render(
      <CommunityLayout>
        <div data-testid="community-child" />
      </CommunityLayout>,
    );
    expect(screen.getByTestId("community-child")).toBeInTheDocument();
  });

  it("replaces the WHOLE route with the full-page paused state", () => {
    // A kill here takes every `/community/*` view, so the rider lands on an
    // otherwise blank page. The gates' default inline card reads as a broken
    // page in that position; the 404-style screen reads as a paused feature.
    killSwitches.community_access = false;
    render(
      <CommunityLayout>
        <div data-testid="community-child" />
      </CommunityLayout>,
    );

    expect(screen.queryByTestId("community-child")).not.toBeInTheDocument();
    expect(screen.getByText("This feature is paused")).toBeInTheDocument();
    expect(screen.getByText("OFF")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /back to home/i }),
    ).toBeInTheDocument();
    // NOT the section-sized notice the gate falls back to by default.
    expect(
      screen.queryByText(/This feature is temporarily unavailable/i),
    ).not.toBeInTheDocument();
  });
});
