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

  it("does not offer Revert on the live version", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    // Fixture: v3 is Live (published), v2 is Archived. Reverting the live
    // version is a no-op the backend rejects, so only the archived row is
    // revertable — exactly one Revert button.
    expect(screen.getAllByRole("button", { name: /^revert$/i })).toHaveLength(
      1,
    );
  });

  it("revert asks for confirmation, then calls the mutation with the version", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    // v3 is Live (no Revert button); the only revertable row is the archived v2.
    fireEvent.click(screen.getAllByRole("button", { name: /^revert$/i })[0]!);
    // Confirm dialog now open — click its confirm button.
    fireEvent.click(screen.getByRole("button", { name: /revert now/i }));
    expect(revertMutate).toHaveBeenCalledTimes(1);
    expect(revertMutate.mock.calls[0]![0]).toEqual({
      params: { path: { tag: "weekly-digest", locale: "en", version: 2 } },
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <VersionHistoryDrawer {...base} open={false} isSuper={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("Escape dismisses the revert confirm without cascade-closing the drawer", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    fireEvent.click(screen.getAllByRole("button", { name: /revert/i })[0]!);
    expect(screen.getByText("Revert to this version?")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("Revert to this version?")).toBeNull();
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it("backdrop-clicking the revert confirm dismisses it without cascade-closing the drawer", () => {
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^revert$/i })[0]!);
    expect(screen.getByText("Revert to this version?")).toBeInTheDocument();

    // Clicking the confirm dialog's own backdrop dismisses it; the event also
    // bubbles to the drawer's overlay onClick, which must NOT cascade-close.
    fireEvent.click(
      screen.getByRole("dialog", { name: "Revert to this version?" }),
    );

    expect(screen.queryByText("Revert to this version?")).toBeNull();
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it("surfaces an error alert when the revert mutation fails", () => {
    revertMutate.mockImplementation(
      (_args: unknown, opts: { onError: (e: unknown) => void }) =>
        opts.onError({ message: "Version 2 is already the live version." }),
    );
    render(<VersionHistoryDrawer {...base} isSuper={true} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^revert$/i })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /revert now/i }));

    expect(screen.getByText(/already the live version/i)).toBeInTheDocument();
    // On failure the confirm is dismissed and no success callback fires.
    expect(screen.queryByText("Revert to this version?")).toBeNull();
    expect(base.onReverted).not.toHaveBeenCalled();
  });
});
