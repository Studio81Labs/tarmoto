import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer.js";

const revertMutate = vi.fn();
const historyRefetch = vi.fn();
const historyState = vi.hoisted(() => ({
  data: [
    {
      version: 3,
      status: "published",
      author: "jane@tarmoto.app",
      publishedAt: "2026-07-10T00:00:00.000Z",
      subject: "s3",
      blocks: [{ type: "paragraph", text: "v3" }],
    },
    {
      version: 2,
      status: "archived",
      author: null,
      publishedAt: "2026-07-01T00:00:00.000Z",
      subject: "s2",
      blocks: [],
    },
  ] as unknown,
}));

vi.mock("../../data/useAdminEmailTemplates.js", () => ({
  useTemplateHistory: () => ({
    data: historyState.data,
    isPending: false,
    refetch: historyRefetch,
  }),
  useRevertVersion: () => ({ mutate: revertMutate, isPending: false }),
  usePreview: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("VersionHistoryDrawer", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    open: true,
    tag: "weekly-digest",
    locale: "en",
    onClose: vi.fn(),
    onReverted: vi.fn(),
  };

  it("lists versions with a Live badge and resolved author, System for null", () => {
    render(<VersionHistoryDrawer {...base} isSuper={false} />);
    expect(screen.getByText(/v3/)).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("jane@tarmoto.app")).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("hides Revert for non-super, shows it for super", () => {
    const { rerender } = render(
      <VersionHistoryDrawer {...base} isSuper={false} />,
    );
    expect(screen.queryByRole("button", { name: /revert/i })).toBeNull();
    rerender(<VersionHistoryDrawer {...base} isSuper={true} />);
    expect(
      screen.getAllByRole("button", { name: /revert/i }).length,
    ).toBeGreaterThan(0);
  });

  it("revert asks for confirmation, then calls the mutation with the version", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]!);
    // Confirm dialog now open — click its confirm button.
    fireEvent.click(screen.getByRole("button", { name: /revert now/i }));
    expect(revertMutate).toHaveBeenCalledTimes(1);
    expect(revertMutate.mock.calls[0]![0]).toEqual({
      params: { path: { tag: "weekly-digest", locale: "en", version: 3 } },
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <VersionHistoryDrawer {...base} open={false} isSuper={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
