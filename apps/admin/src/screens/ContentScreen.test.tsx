import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContentScreen } from "./ContentScreen.js";

vi.mock("../data/useAdminContent.js", () => ({
  useAdminContentList: () => ({
    data: {
      rows: [
        {
          type: "hazard",
          id: "h1",
          authorId: "u1",
          authorName: "Alice",
          text: "pothole",
          photoUrls: [],
          createdAt: "2026-01-01T00:00:00Z",
          status: "visible",
          moderationReason: null,
          moderatedAt: null,
          location: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useHideContent: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreContent: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteContent: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("ContentScreen", () => {
  it("renders content rows", () => {
    render(<ContentScreen currentRole="admin" />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("pothole")).toBeInTheDocument();
  });

  it("hides the delete control for support-level admins", () => {
    render(<ContentScreen currentRole="support" />);
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows the delete control for admin-level admins", () => {
    render(<ContentScreen currentRole="admin" />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
