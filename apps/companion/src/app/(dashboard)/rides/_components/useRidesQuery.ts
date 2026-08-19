"use client";

import { useTranslation } from "@/i18n/I18nProvider";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { components } from "@tarmoto/openapi-client";
import { getUserFacingErrorMessage } from "@/i18n";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { parseTimeWindow, windowStartISO } from "./TimeWindowPills";

export type SortField =
  "started_at" | "distance_km" | "duration_min" | "avg_road_quality";
export type SortOrder = "asc" | "desc";

export interface RidesFilters {
  from?: string | undefined; // ISO date, YYYY-MM-DD
  to?: string | undefined;
  minDistance?: number | undefined;
  maxDistance?: number | undefined;
  minQuality?: number | undefined;
  maxQuality?: number | undefined;
  q?: string | undefined;
  type?: string | undefined;
  // Location filter — all four fields move together. `nearPlace` is the
  // resolved label we show in the UI; it doesn't travel to the backend.
  nearLat?: number | undefined;
  nearLng?: number | undefined;
  nearKm?: number | undefined;
  nearPlace?: string | undefined;
}

export interface RidesQueryState extends RidesFilters {
  sort: SortField;
  order: SortOrder;
  page: number; // 1-based
  /**
   * Effective `started_from` lower bound sent to the API: the later of the
   * advanced "From" date filter and the shared `?window=` time-pill bound.
   * Kept separate from `from` so the advanced date input still shows the
   * user's own value while the relative time pill ("Last 90 days") layers on top.
   */
  effectiveFrom?: string | undefined;
}

const PAGE_SIZE = 20;

export function parseQuery(params: URLSearchParams): RidesQueryState {
  const num = (k: string) => {
    const v = params.get(k);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) => params.get(k) || undefined;

  const sortRaw = str("sort");
  const sort: SortField =
    sortRaw === "distance_km" ||
    sortRaw === "duration_min" ||
    sortRaw === "avg_road_quality"
      ? sortRaw
      : "started_at";
  const orderRaw = str("order");
  const order: SortOrder = orderRaw === "asc" ? "asc" : "desc";
  const pageNum = Math.max(1, Math.floor(num("page") ?? 1));

  // Location filter is all-or-nothing: coords without a radius (or vice
  // versa) would silently resolve to a no-op filter on the backend. Drop
  // any partial set rather than surfacing an invalid half-state.
  const nLat = num("nearLat");
  const nLng = num("nearLng");
  const nKm = num("nearKm");
  const nearComplete = nLat != null && nLng != null && nKm != null;

  // Shared time-window pill (`?window=`) → relative `started_from` lower
  // bound. The effective bound the API sees is the later (more restrictive)
  // of the advanced "From" filter and this window start, so the two controls
  // compose instead of clobbering each other.
  const advancedFrom = str("from");
  const windowFrom = windowStartISO(parseTimeWindow(params.get("window")));
  const effectiveFrom =
    advancedFrom && windowFrom
      ? advancedFrom > windowFrom
        ? advancedFrom
        : windowFrom
      : (advancedFrom ?? windowFrom ?? undefined);

  return {
    from: advancedFrom,
    effectiveFrom,
    to: str("to"),
    minDistance: num("minDist"),
    maxDistance: num("maxDist"),
    minQuality: num("minQ"),
    maxQuality: num("maxQ"),
    q: str("q"),
    type: str("type"),
    nearLat: nearComplete ? nLat : undefined,
    nearLng: nearComplete ? nLng : undefined,
    nearKm: nearComplete ? nKm : undefined,
    nearPlace: nearComplete ? str("nearPlace") : undefined,
    sort,
    order,
    page: pageNum,
  };
}

export function serializeQuery(
  state: Partial<RidesQueryState>,
  window?: string,
): string {
  const u = new URLSearchParams();
  if (state.from) u.set("from", state.from);
  if (state.to) u.set("to", state.to);
  if (state.minDistance != null) u.set("minDist", String(state.minDistance));
  if (state.maxDistance != null) u.set("maxDist", String(state.maxDistance));
  if (state.minQuality != null) u.set("minQ", String(state.minQuality));
  if (state.maxQuality != null) u.set("maxQ", String(state.maxQuality));
  if (state.q) u.set("q", state.q);
  if (state.type) u.set("type", state.type);
  if (state.nearLat != null && state.nearLng != null && state.nearKm != null) {
    u.set("nearLat", String(state.nearLat));
    u.set("nearLng", String(state.nearLng));
    u.set("nearKm", String(state.nearKm));
    if (state.nearPlace) u.set("nearPlace", state.nearPlace);
  }
  if (state.sort && state.sort !== "started_at") u.set("sort", state.sort);
  if (state.order && state.order !== "desc") u.set("order", state.order);
  if (state.page && state.page !== 1) u.set("page", String(state.page));
  // The shared time-window pill lives in `?window=` (read by both the
  // All-rides and Road-map tabs). It's not part of `RidesQueryState`, so
  // preserve it verbatim across filter/sort/page updates here rather than
  // having every `update()` silently reset the window to "all".
  if (window && window !== "all") u.set("window", window);
  return u.toString();
}

function toListParams(s: RidesQueryState): Record<string, string | number> {
  const p: Record<string, string | number> = {
    limit: PAGE_SIZE,
    offset: (s.page - 1) * PAGE_SIZE,
    sort: s.sort,
    order: s.order,
  };
  if (s.effectiveFrom) p.started_from = s.effectiveFrom;
  if (s.to) p.started_to = s.to;
  if (s.minDistance != null) p.min_distance_km = s.minDistance;
  if (s.maxDistance != null) p.max_distance_km = s.maxDistance;
  if (s.minQuality != null) p.min_quality = s.minQuality;
  if (s.maxQuality != null) p.max_quality = s.maxQuality;
  if (s.q) p.q = s.q;
  if (s.type) p.type = s.type;
  if (s.nearLat != null && s.nearLng != null && s.nearKm != null) {
    p.near_lat = s.nearLat;
    p.near_lng = s.nearLng;
    p.near_km = s.nearKm;
  }
  return p;
}

/**
 * The filter-only params shared by `GET /rides` and `GET /rides/stats` —
 * pagination/sort stripped. Exported so the KPI-stats hook reflects the EXACT
 * same filter window the table renders, keeping the cards and the list in
 * lockstep.
 */
export function toFilterParams(
  s: RidesQueryState,
): Record<string, string | number> {
  const {
    limit: _l,
    offset: _o,
    sort: _s,
    order: _ord,
    ...rest
  } = toListParams(s);
  void _l;
  void _o;
  void _s;
  void _ord;
  return rest;
}

/** Ride History list rows — the generated `RideSummaryDto`. */
export type RideSummary = components["schemas"]["RideSummaryDto"];

interface ListResult {
  rides: RideSummary[];
  total: number;
  loading: boolean;
  error: string | null;
}

export function useRidesQuery() {
  const t = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Gate at the ONE place every consumer reads from — the API query, the
  // filter chips, the active-filter count, the table's sort indicator and the
  // KPI hook all derive from this state, and correcting it here means none of
  // them has to remember. Three earlier PRs on this epic each cost a review
  // round by deriving one reader and missing another.
  const { enabled: qualityEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const rawState = useMemo(() => parseQuery(params), [params]);
  const state = useMemo<RidesQueryState>(() => {
    if (qualityEnabled) return rawState;
    // The URL keeps `minQ`/`maxQ`/`sort=avg_road_quality` — it is the rider's
    // own visible state and rewriting their address bar during an operator
    // incident would be worse. It simply stops taking effect, and resumes if
    // the switch returns. Distinct from a CONSUMED deep link (#1202), where
    // the params were stripped and the banked state fired unprompted later.
    const { minQuality: _min, maxQuality: _max, ...rest } = rawState;
    return {
      ...rest,
      sort: rawState.sort === "avg_road_quality" ? "started_at" : rawState.sort,
    };
  }, [rawState, qualityEnabled]);

  // Keep the latest RAW state in a ref so `update` merges against the current
  // snapshot even when callers hold a stale closure — e.g. a setTimeout
  // debounce in RidesFilters that captured the `update` identity from a
  // previous render. Without this, a concurrent filter change during the
  // debounce window would be clobbered by the merge.
  //
  // RAW, not the gated snapshot, because `update()` SERIALIZES its merge back
  // into the URL: merging the stripped state would write the stripped values
  // out, so the first filter change during a kill would permanently delete the
  // rider's `minQ`/`maxQ`/`sort`. The gated state drives everything the rider
  // sees and everything sent to the API; only serialization reads this one.
  const rawStateRef = useRef(rawState);
  useEffect(() => {
    rawStateRef.current = rawState;
  }, [rawState]);

  // The shared `?window=` pill isn't part of `RidesQueryState`, so the ref
  // doesn't carry it — mirror it in its own ref. A debounced `update()` (the
  // 300 ms search box in RidesFilters) can fire after the rider switches the
  // window pill; reading `params.get("window")` off the stale closure would
  // then serialize the *previous* window and snap the list/KPIs back to all
  // time. Reading the ref at call time always sees the latest committed value.
  const windowParam = params.get("window");
  const windowRef = useRef(windowParam);
  useEffect(() => {
    windowRef.current = windowParam;
  }, [windowParam]);

  // Gate fetches on the access token being hydrated by `AuthSync`.
  // Without this, both the list and tracks effects fire on mount before
  // `useSession` returns and Zustand picks up the user's token — the
  // outbound requests then go without a Bearer header and the backend
  // 401s. `useUserTrips` (`/trips`) uses the same pattern.
  const authReady = useAuthStore((s) => Boolean(s.accessToken));

  // ── list fetch ──
  const [list, setList] = useState<ListResult>({
    rides: [],
    total: 0,
    loading: true,
    error: null,
  });
  useEffect(() => {
    if (!authReady) return;
    const ctrl = new AbortController();
    setList((s) => ({ ...s, loading: true, error: null }));
    api
      .GET("/api/v1/rides", {
        params: { query: toListParams(state) as never },
        signal: ctrl.signal,
      })
      .then(({ data, error }) => {
        if (ctrl.signal.aborted) return;
        if (error) {
          setList({
            rides: [],
            total: 0,
            loading: false,
            error: t("Failed to load rides"),
          });
          return;
        }
        setList({
          rides: data?.rides ?? [],
          total: data?.total ?? 0,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setList({
          rides: [],
          total: 0,
          loading: false,
          error: getUserFacingErrorMessage(err, t("Could not load rides")),
        });
      });
    return () => ctrl.abort();
  }, [t, authReady, state]);

  // Clamp an out-of-range page once the count is known. A stale/bookmarked
  // `?page=` (or data shrinking below the page boundary) would otherwise
  // request an empty offset and render "No rides match" while page 1 has
  // rides. Resetting to the last valid page is a bare page change, so it
  // doesn't wipe the active filters.
  useEffect(() => {
    if (list.loading || list.error) return;
    const maxPage = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
    if (state.page > maxPage) update({ page: maxPage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.loading, list.error, list.total, state.page]);

  function update(patch: Partial<RidesQueryState>) {
    // Read the freshest state via the ref so stale-closure callers still
    // merge against the current snapshot (see `rawStateRef` above).
    // Any update other than a bare page-click resets to page 1: filter,
    // sort, and order changes all mean the current page number is stale —
    // e.g. going from 5 pages of started_at DESC to 2 pages of distance_km
    // ASC would leave the user staring at an empty page.
    // Merge onto the RAW state: this result is serialized straight into the
    // URL, and a killed page must not silently drop the quality params the
    // rider still owns. A patch that explicitly sets one still wins, so the
    // controls (which are hidden during a kill anyway) behave normally.
    const current = rawStateRef.current;
    const keys = Object.keys(patch);
    const isBarePageChange = keys.length === 1 && keys[0] === "page";
    const next: RidesQueryState = {
      ...current,
      ...patch,
      page: isBarePageChange ? (patch.page ?? current.page) : 1,
    };
    // Preserve the shared `?window=` pill across filter/sort/page changes.
    // Read it from the ref (not the closure's `params`) so a stale debounced
    // caller still serializes the window the rider currently has selected.
    const qs = serializeQuery(next, windowRef.current ?? undefined);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function reset() {
    // Reset clears advanced filters but keeps the shared time-window pill —
    // it's a top-level control on the tab row, not a filter-bar field. Read
    // from the ref so a stale closure still preserves the current window.
    const w = windowRef.current;
    const qs = w && w !== "all" ? `window=${w}` : "";
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return { state, list, update, reset, pageSize: PAGE_SIZE };
}
