import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useMediaQuery } from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Renders a probe that records `useMediaQuery`'s value on EVERY render, so a
// test can assert what the *first* committed render carried — the property
// that decides whether a (re)mounting component flashes the wrong value.
function recordMediaQueryRenders(query: string): boolean[] {
  const values: boolean[] = [];
  function Probe() {
    values.push(useMediaQuery(query));
    return null;
  }
  render(<Probe />);
  return values;
}

describe("useMediaQuery", () => {
  it("returns the live match on the FIRST render — no post-mount flip (anti-flash)", () => {
    // Pretend we're on a compact (tablet) viewport.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width: 1023px"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    const values = recordMediaQueryRenders("(max-width: 1023px)");

    // `useSyncExternalStore` reads `getSnapshot` during render, so the very
    // first committed value is already `true`. An effect-based hook would emit
    // the SSR default (`false`) first and flip after mount — which is exactly
    // the sidebar's expand→collapse flash on a cross-layout remount.
    expect(values[0]).toBe(true);
    expect(values.every((v) => v === true)).toBe(true);
  });

  it("reacts when the viewport crosses the breakpoint", () => {
    const state = { compact: false };
    let listener: (() => void) | null = null;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return state.compact && query.includes("max-width: 1023px");
        },
        addEventListener: (_event: string, cb: () => void) => {
          listener = cb;
        },
        removeEventListener: () => {
          listener = null;
        },
      })),
    );

    const values = recordMediaQueryRenders("(max-width: 1023px)");
    expect(values[0]).toBe(false);

    act(() => {
      state.compact = true;
      listener?.();
    });
    expect(values[values.length - 1]).toBe(true);
  });

  it("subscribes via legacy addListener when addEventListener is absent (old WebKit)", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      // Older Safari / iPadOS expose only the deprecated listener API.
      vi.fn((query: string) => ({
        matches: query.includes("max-width: 1023px"),
        addListener,
        removeListener,
      })),
    );

    const values = recordMediaQueryRenders("(max-width: 1023px)");

    // Synchronous read still works, and we subscribe through the legacy API
    // instead of throwing on the missing `addEventListener`.
    expect(values[0]).toBe(true);
    expect(addListener).toHaveBeenCalledTimes(1);
  });
});
