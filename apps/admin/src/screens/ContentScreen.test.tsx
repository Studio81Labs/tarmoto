import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
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
          photoUrls: ["https://cdn.tarmoto.app/hazard-photos/p1.jpg"],
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

  it("renders attachment thumbnails linking to the photo URL", () => {
    render(<ContentScreen currentRole="admin" />);
    const link = screen.getByRole("link", { name: /attachment 1/i });
    expect(link).toHaveAttribute(
      "href",
      "https://cdn.tarmoto.app/hazard-photos/p1.jpg",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("hides the delete control for support-level admins", () => {
    render(<ContentScreen currentRole="support" />);
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows the delete control for admin-level admins", () => {
    render(<ContentScreen currentRole="admin" />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("Hide opens a dialog that hides with the entered reason and refetches on success", async () => {
    const user = userEvent.setup();
    render(<ContentScreen currentRole="admin" />);
    // Row action opens the confirm dialog (no mutation yet).
    await user.click(screen.getByRole("button", { name: /^hide$/i }));
    expect(mockHide).not.toHaveBeenCalled();

    await user.type(
      screen.getByRole("textbox", { name: /reason for hiding/i }),
      "spam",
    );
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^hide$/i }));

    expect(mockHide).toHaveBeenCalledWith(
      {
        params: { path: { type: "hazard", id: "h1" } },
        body: { reason: "spam" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, { onSuccess }] = mockHide.mock.calls[0] as [
      unknown,
      { onSuccess: () => void },
    ];
    act(() => {
      onSuccess();
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("Cancel in the hide dialog does not hide", async () => {
    const user = userEvent.setup();
    render(<ContentScreen currentRole="admin" />);
    await user.click(screen.getByRole("button", { name: /^hide$/i }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(mockHide).not.toHaveBeenCalled();
  });
});
