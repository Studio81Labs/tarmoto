import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastHost } from "./ToastHost";
import { toast } from "@/lib/toast";
import { useToastStore } from "@/stores/toast";

describe("ToastHost", () => {
  beforeEach(() => {
    useToastStore.getState().dismissAll();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing when the queue is empty", () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a fired toast's title and description", () => {
    render(<ToastHost />);
    act(() => {
      toast.error("Could not generate route", { description: "Try again." });
    });
    expect(screen.getByText("Could not generate route")).toBeInTheDocument();
    expect(screen.getByText("Try again.")).toBeInTheDocument();
  });

  it("auto-dismisses after the duration elapses", () => {
    render(<ToastHost />);
    act(() => {
      toast.success("Saved", { durationMs: 4000 });
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps a persistent toast (durationMs null) until dismissed", () => {
    render(<ToastHost />);
    act(() => {
      toast.info("Stays put", { durationMs: null });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Stays put")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Stays put")).not.toBeInTheDocument();
  });

  it("caps the visible stack at 4", () => {
    render(<ToastHost />);
    act(() => {
      for (let i = 1; i <= 6; i += 1) {
        toast.info(`Toast ${i}`, { durationMs: null });
      }
    });
    expect(screen.queryByText("Toast 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Toast 2")).not.toBeInTheDocument();
    expect(screen.getByText("Toast 3")).toBeInTheDocument();
    expect(screen.getByText("Toast 6")).toBeInTheDocument();
  });

  it("fires the action handler and dismisses on click", () => {
    const onAction = vi.fn();
    render(<ToastHost />);
    act(() => {
      toast.info("Undo?", {
        durationMs: null,
        actionLabel: "Undo",
        onAction,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByText("Undo?")).not.toBeInTheDocument();
  });
});
