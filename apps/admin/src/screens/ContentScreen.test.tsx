import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentScreen } from "./ContentScreen.js";

const mockHide = vi.fn();
const mockRestore = vi.fn();
const mockDelete = vi.fn();
const mockRefetch = vi.fn();

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
    refetch: mockRefetch,
  }),
  useHideContent: () => ({ mutate: mockHide, isPending: false }),
  useRestoreContent: () => ({ mutate: mockRestore, isPending: false }),
  useDeleteContent: () => ({ mutate: mockDelete, isPending: false }),
}));

describe("ContentScreen", () => {
  beforeEach(() => {
    mockHide.mockClear();
    mockRestore.mockClear();
    mockDelete.mockClear();
    mockRefetch.mockClear();
  });

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

  it("Hide button invokes hide mutation with correct path params and body, and onSuccess refetches", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("spam");
    render(<ContentScreen currentRole="admin" />);
    await userEvent.click(screen.getByRole("button", { name: /^hide$/i }));

    expect(mockHide).toHaveBeenCalledWith(
      {
        params: { path: { type: "hazard", id: "h1" } },
        body: { reason: "spam" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Invoke the captured onSuccess and verify refetch is called
    const [, { onSuccess }] = mockHide.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("does not hide when the reason prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<ContentScreen currentRole="admin" />);
    await userEvent.click(screen.getByRole("button", { name: /^hide$/i }));
    expect(mockHide).not.toHaveBeenCalled();
  });
});
