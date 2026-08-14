import { vi, describe, it, expect, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Mock Next.js navigation and other runtime-only deps so the module can be
// imported in a plain Node/jsdom environment without a running Next.js server.
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { GET: vi.fn() },
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(),
}));

import {
  parseQuery,
  serializeQuery,
  toFilterParams,
  useRidesQuery,
} from "./useRidesQuery";
import { windowStartISO } from "./TimeWindowPills";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";

// `road_quality_overlay` gates the quality column/tile/filter; the real hook
// needs a QueryClientProvider these suites do not render. Keyed so a case that
// kills one switch cannot silently flip another.
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

// Fixed reference date used to derive expected window bounds.
// 2026-06-04T00:00:00Z:
//   30d bound → 2026-05-05
//   90d bound → 2026-03-06
//   year bound → 2026-01-01
//
// parseQuery calls windowStartISO(parseTimeWindow(...)) with the *real* clock.
// To make the tests deterministic we pin the system time to the same reference.
const FIXED_NOW = new Date("2026-06-04T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

// Restore real timers after each test so other test files are unaffected.
afterEach(() => {
  vi.useRealTimers();
});

// ── helpers ────────────────────────────────────────────────────────────────

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj);
}

// ── parseQuery — effectiveFrom composition ─────────────────────────────────

describe("parseQuery — effectiveFrom", () => {
  it("window-only: started_from equals the window lower bound", () => {
    const state = parseQuery(params({ window: "30d" }));
    const expected = windowStartISO("30d", FIXED_NOW);
    expect(state.effectiveFrom).toBe(expected); // 2026-05-05
    expect(state.from).toBeUndefined();
  });

  it("advanced-from only with window=all: started_from equals the advanced from date", () => {
    const state = parseQuery(params({ from: "2026-05-20", window: "all" }));
    expect(state.effectiveFrom).toBe("2026-05-20");
    expect(state.from).toBe("2026-05-20");
  });

  it("both filters, advanced from LATER: the later (more restrictive) wins", () => {
    // window=90d bound is 2026-03-06; advanced from 2026-05-20 is later → wins
    const state = parseQuery(params({ from: "2026-05-20", window: "90d" }));
    expect(state.effectiveFrom).toBe("2026-05-20");
    expect(state.from).toBe("2026-05-20");
  });

  it("both filters, window lower bound LATER: the window bound wins", () => {
    // window=30d bound is 2026-05-05; advanced from 2026-01-01 is earlier → window wins
    const state = parseQuery(params({ from: "2026-01-01", window: "30d" }));
    const windowBound = windowStartISO("30d", FIXED_NOW); // 2026-05-05
    expect(state.effectiveFrom).toBe(windowBound);
    expect(state.from).toBe("2026-01-01"); // user's own value preserved
  });

  it("no filters at all: effectiveFrom is undefined", () => {
    const state = parseQuery(params({}));
    expect(state.effectiveFrom).toBeUndefined();
  });

  it("window=year: lower bound is January 1st of the current year", () => {
    const state = parseQuery(params({ window: "year" }));
    expect(state.effectiveFrom).toBe("2026-01-01");
  });

  it("window=all with no advanced from: effectiveFrom is undefined", () => {
    const state = parseQuery(params({ window: "all" }));
    expect(state.effectiveFrom).toBeUndefined();
  });
});

// ── parseQuery — ?window= preserved in state ──────────────────────────────

describe("parseQuery — ?window= param is preserved and affects effectiveFrom only", () => {
  it("does not clobber the user's own from field", () => {
    const state = parseQuery(params({ from: "2026-04-01", window: "30d" }));
    // effectiveFrom = max("2026-04-01", "2026-05-05") = window bound
    expect(state.effectiveFrom).toBe("2026-05-05");
    // but the UI date input should still show the user's value
    expect(state.from).toBe("2026-04-01");
  });
});

// ── toFilterParams — started_from maps from effectiveFrom ─────────────────

describe("toFilterParams", () => {
  it("emits started_from from effectiveFrom, not the raw from date", () => {
    const state = parseQuery(params({ from: "2026-01-01", window: "30d" }));
    const fp = toFilterParams(state);
    // effectiveFrom = 2026-05-05 (window bound wins)
    expect(fp.started_from).toBe("2026-05-05");
  });

  it("omits started_from when there is no effective bound", () => {
    const state = parseQuery(params({}));
    const fp = toFilterParams(state);
    expect(fp.started_from).toBeUndefined();
  });

  it("does not include pagination or sort fields", () => {
    const state = parseQuery(params({ window: "30d" }));
    const fp = toFilterParams(state);
    expect(fp).not.toHaveProperty("limit");
    expect(fp).not.toHaveProperty("offset");
    expect(fp).not.toHaveProperty("sort");
    expect(fp).not.toHaveProperty("order");
  });
});

// ── serializeQuery — ?window= round-trips ────────────────────────────────

describe("serializeQuery — ?window= preservation", () => {
  it("serializes window=30d when provided", () => {
    const state = parseQuery(params({ window: "30d" }));
    const qs = serializeQuery(state, "30d");
    expect(new URLSearchParams(qs).get("window")).toBe("30d");
  });

  it("omits window param when value is 'all'", () => {
    const state = parseQuery(params({}));
    const qs = serializeQuery(state, "all");
    expect(new URLSearchParams(qs).get("window")).toBeNull();
  });

  it("omits window param when window is undefined", () => {
    const state = parseQuery(params({ from: "2026-05-01" }));
    const qs = serializeQuery(state);
    expect(new URLSearchParams(qs).get("window")).toBeNull();
  });

  it("does not serialize effectiveFrom — only from travels in the URL", () => {
    const state = parseQuery(params({ from: "2026-01-01", window: "30d" }));
    const qs = serializeQuery(state, "30d");
    const parsed = new URLSearchParams(qs);
    expect(parsed.get("from")).toBe("2026-01-01");
    // effectiveFrom is a derived field, not a URL key
    expect(parsed.get("effectiveFrom")).toBeNull();
  });
});

// ── update() — latest window survives a stale debounced caller ─────────────

describe("useRidesQuery — window preserved for a stale debounced update", () => {
  it("serializes the current window even when update() is a stale closure", () => {
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(usePathname).mockReturnValue("/rides");
    // Auth gate off → the list-fetch effect early-returns, so we don't need
    // to stub api.GET; we're only exercising the update() URL serialization.
    vi.mocked(useAuthStore).mockReturnValue(false as never);

    // Mutable search params the mock reads each render, so we can simulate the
    // rider switching the window pill between scheduling and firing a debounce.
    let current = new URLSearchParams(); // window defaults to "all"
    vi.mocked(useSearchParams).mockImplementation(() => current as never);

    const { result, rerender } = renderHook(() => useRidesQuery());

    // A debounced caller (e.g. the 300 ms search box) captures THIS update.
    const staleUpdate = result.current.update;

    // Rider switches the window pill → URL gains ?window=30d → rerender.
    current = new URLSearchParams("window=30d");
    rerender();

    // The debounce fires now, using the stale closure from before the switch.
    act(() => {
      staleUpdate({ q: "ridge" });
    });

    expect(replace).toHaveBeenCalledTimes(1);
    const replaceCall = replace.mock.calls[0];
    if (!replaceCall) throw new Error("expected replace to have been called");
    const url = replaceCall[0] as string;
    expect(url).toContain("window=30d"); // latest window, not the stale "all"
    expect(url).toContain("q=ridge");
  });
});

// ── clamp an out-of-range ?page= once the count is known ───────────────────

describe("useRidesQuery — out-of-range page clamping", () => {
  it("resets a stale ?page= past the last page back to a valid page", async () => {
    // waitFor needs real timers; the file pins fake timers in beforeEach.
    vi.useRealTimers();
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(usePathname).mockReturnValue("/rides");
    vi.mocked(useAuthStore).mockReturnValue(true as never); // authReady
    // ?page=5, but only 15 rides exist → a single page. The mock returns the
    // same params object every render, so once clamped the effect settles.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("page=5") as never,
    );
    vi.mocked(api.GET).mockResolvedValue({
      data: { rides: [], total: 15 },
      error: undefined,
    } as never);

    renderHook(() => useRidesQuery());

    // Clamped to page 1 → page param dropped → bare pathname.
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/rides", { scroll: false }),
    );
  });
});

describe("useRidesQuery — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
  });

  it("keeps URL quality filters and the quality sort while the flag is live", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "minQ=3&maxQ=5&sort=avg_road_quality&order=asc",
      ) as never,
    );
    const { result } = renderHook(() => useRidesQuery());
    expect(result.current.state.minQuality).toBe(3);
    expect(result.current.state.maxQuality).toBe(5);
    expect(result.current.state.sort).toBe("avg_road_quality");
  });

  it("refuses URL-restored quality filters and sort under the kill", () => {
    // These live in the ADDRESS BAR, so unlike a consumed deep link they are
    // not one-shot — a killed page reached from a bookmark or a shared link
    // would otherwise filter and sort on the dimension the operator removed.
    killSwitches.road_quality_overlay = false;
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "minQ=3&maxQ=5&sort=avg_road_quality&order=asc",
      ) as never,
    );
    const { result } = renderHook(() => useRidesQuery());

    expect(result.current.state.minQuality).toBeUndefined();
    expect(result.current.state.maxQuality).toBeUndefined();
    expect(result.current.state.sort).toBe("started_at");
    // Everything else the URL carried survives — the kill takes the quality
    // dimension, not the rider's whole filter set.
    expect(result.current.state.order).toBe("asc");
  });

  it("restores them if the operator turns the switch back on", () => {
    // The URL is the rider's own visible state, so we do not rewrite their
    // address bar during an incident; it simply stops taking effect.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("minQ=3") as never,
    );
    killSwitches.road_quality_overlay = false;
    const { result, rerender } = renderHook(() => useRidesQuery());
    expect(result.current.state.minQuality).toBeUndefined();

    killSwitches.road_quality_overlay = true;
    rerender();
    expect(result.current.state.minQuality).toBe(3);
  });
});
