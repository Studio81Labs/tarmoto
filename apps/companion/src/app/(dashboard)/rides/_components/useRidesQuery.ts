"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

export type SortField =
  | "started_at"
  | "distance_km"
  | "duration_min"
  | "avg_road_quality";
export type SortOrder = "asc" | "desc";

export interface RidesFilters {
  from?: string; // ISO date, YYYY-MM-DD
  to?: string;
  minDistance?: number;
  maxDistance?: number;
  minQuality?: number;
  maxQuality?: number;
  q?: string;
  type?: string;
}

export interface RidesQueryState extends RidesFilters {
  sort: SortField;
  order: SortOrder;
  page: number; // 1-based
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

  return {
    from: str("from"),
    to: str("to"),
    minDistance: num("minDist"),
    maxDistance: num("maxDist"),
    minQuality: num("minQ"),
    maxQuality: num("maxQ"),
    q: str("q"),
    type: str("type"),
    sort,
    order,
    page: pageNum,
  };
}

export function serializeQuery(state: Partial<RidesQueryState>): string {
  const u = new URLSearchParams();
  if (state.from) u.set("from", state.from);
  if (state.to) u.set("to", state.to);
  if (state.minDistance != null) u.set("minDist", String(state.minDistance));
  if (state.maxDistance != null) u.set("maxDist", String(state.maxDistance));
  if (state.minQuality != null) u.set("minQ", String(state.minQuality));
  if (state.maxQuality != null) u.set("maxQ", String(state.maxQuality));
  if (state.q) u.set("q", state.q);
  if (state.type) u.set("type", state.type);
  if (state.sort && state.sort !== "started_at") u.set("sort", state.sort);
  if (state.order && state.order !== "desc") u.set("order", state.order);
  if (state.page && state.page !== 1) u.set("page", String(state.page));
  return u.toString();
}

function toListParams(s: RidesQueryState): Record<string, string | number> {
  const p: Record<string, string | number> = {
    limit: PAGE_SIZE,
    offset: (s.page - 1) * PAGE_SIZE,
    sort: s.sort,
    order: s.order,
  };
  if (s.from) p.started_from = s.from;
  if (s.to) p.started_to = s.to;
  if (s.minDistance != null) p.min_distance_km = s.minDistance;
  if (s.maxDistance != null) p.max_distance_km = s.maxDistance;
  if (s.minQuality != null) p.min_quality = s.minQuality;
  if (s.maxQuality != null) p.max_quality = s.maxQuality;
  if (s.q) p.q = s.q;
  if (s.type) p.type = s.type;
  return p;
}

function toTracksParams(s: RidesQueryState): Record<string, string | number> {
  // Same filters as list, minus pagination/sort.
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

export interface RideSummary {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  ride_type: string;
  status: string;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  duration_min: number | null;
}

export interface RideTrack {
  id: string;
  geometry: { type: "LineString"; coordinates: number[][] } | null;
}

interface ListResult {
  rides: RideSummary[];
  total: number;
  loading: boolean;
  error: string | null;
}

interface TracksResult {
  tracks: RideTrack[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export function useRidesQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => parseQuery(params), [params]);

  // ── list fetch ──
  const [list, setList] = useState<ListResult>({
    rides: [],
    total: 0,
    loading: true,
    error: null,
  });
  useEffect(() => {
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
            error: "Failed to load rides",
          });
          return;
        }
        const d = data as unknown as { rides: RideSummary[]; total: number };
        setList({
          rides: d.rides ?? [],
          total: d.total ?? 0,
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setList({
          rides: [],
          total: 0,
          loading: false,
          error: err.message,
        });
      });
    return () => ctrl.abort();
  }, [state]);

  // ── tracks fetch (debounced on filter changes) ──
  const [tracks, setTracks] = useState<TracksResult>({
    tracks: [],
    truncated: false,
    loading: true,
    error: null,
  });
  const tracksKey = useMemo(
    () => JSON.stringify(toTracksParams(state)),
    [state],
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const ctrl = new AbortController();
    setTracks((s) => ({ ...s, loading: true, error: null }));
    debounceRef.current = setTimeout(() => {
      api
        .GET("/api/v1/rides/tracks", {
          params: { query: toTracksParams(state) as never },
          signal: ctrl.signal,
        })
        .then(({ data, error }) => {
          if (ctrl.signal.aborted) return;
          if (error) {
            setTracks({
              tracks: [],
              truncated: false,
              loading: false,
              error: "Failed to load tracks",
            });
            return;
          }
          const d = data as unknown as {
            tracks: RideTrack[];
            truncated: boolean;
          };
          setTracks({
            tracks: d.tracks ?? [],
            truncated: !!d.truncated,
            loading: false,
            error: null,
          });
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted) return;
          setTracks({
            tracks: [],
            truncated: false,
            loading: false,
            error: err.message,
          });
        });
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      ctrl.abort();
    };
    // tracksKey captures every param that affects this fetch; state is
    // intentionally excluded so pagination/sort changes don't re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey]);

  function update(patch: Partial<RidesQueryState>) {
    // Any filter change (anything other than page/sort/order) resets page to 1.
    const isFilterChange = Object.keys(patch).some(
      (k) => k !== "page" && k !== "sort" && k !== "order",
    );
    const next: RidesQueryState = {
      ...state,
      ...patch,
      page: isFilterChange ? 1 : (patch.page ?? state.page),
    };
    const qs = serializeQuery(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function reset() {
    router.replace(pathname, { scroll: false });
  }

  return { state, list, tracks, update, reset, pageSize: PAGE_SIZE };
}
