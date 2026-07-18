import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useMediaQuery, usePersistentState } from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
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

describe("usePersistentState", () => {
  // Records the value on every render and exposes the setter, so a test can
  // assert what the FIRST render carried (the anti-flash property) and drive
  // updates.
  function recordPersistentRenders<T extends string | number | boolean | null>(
    key: string,
    fallback: T,
  ) {
    const values: T[] = [];
    let setter: ((value: T) => void) | null = null;
    function Probe() {
      const [value, setValue] = usePersistentState(key, fallback);
      setter = setValue;
      values.push(value);
      return null;
    }
    render(<Probe />);
    return {
      values,
      set: (value: T) => act(() => setter?.(value)),
    };
  }

  it("reads a stored value on the FIRST render — no post-mount flip (anti-flash)", () => {
    // A rider who collapsed the sidebar earlier: the preference is already in
    // storage before the (re)mount.
    localStorage.setItem("tarmoto:sidebar-collapsed", "true");

    const { values } = recordPersistentRenders<boolean | null>(
      "tarmoto:sidebar-collapsed",
      null,
    );

    // useLocalStorage would emit `null` (fallback) first and flip after the
    // read-effect — the sidebar's expand→collapse flash. Here it's `true` from
    // the first commit.
    expect(values[0]).toBe(true);
    expect(values.every((v) => v === true)).toBe(true);
  });

  it("returns the fallback when nothing is stored", () => {
    const { values } = recordPersistentRenders<boolean | null>(
      "tarmoto:sidebar-collapsed",
      null,
    );
    expect(values[0]).toBeNull();
  });

  it("persists and reactively updates same-tab subscribers on setValue", () => {
    const { values, set } = recordPersistentRenders<boolean | null>(
      "tarmoto:sidebar-collapsed",
      null,
    );

    set(true);
    expect(localStorage.getItem("tarmoto:sidebar-collapsed")).toBe("true");
    expect(values[values.length - 1]).toBe(true);

    set(false);
    expect(localStorage.getItem("tarmoto:sidebar-collapsed")).toBe("false");
    expect(values[values.length - 1]).toBe(false);
  });
});
