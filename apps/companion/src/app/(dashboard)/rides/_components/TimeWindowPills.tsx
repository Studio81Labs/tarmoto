"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type TimeWindow = "all" | "year" | "90d" | "30d";

const OPTIONS: { key: TimeWindow; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "year", label: "This year" },
  { key: "90d", label: "Last 90" },
  { key: "30d", label: "Last 30" },
];

const VALID = new Set<TimeWindow>(["all", "year", "90d", "30d"]);

/** Parse the shared `?window=` search param, defaulting to "all". */
export function parseTimeWindow(value: string | null | undefined): TimeWindow {
  return value && VALID.has(value as TimeWindow)
    ? (value as TimeWindow)
    : "all";
}

/** ISO `YYYY-MM-DD` lower bound for a window, or null for "all". */
export function windowStartISO(w: TimeWindow, now = new Date()): string | null {
  if (w === "all") return null;
  if (w === "year") return `${now.getUTCFullYear()}-01-01`;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - (w === "90d" ? 90 : 30));
  return d.toISOString().slice(0, 10);
}

/**
 * Read the active time window from the URL. Shared between the All-rides
 * table query and the Road-map period so a pill change on one tab carries
 * to the other and survives tab switches.
 */
export function useTimeWindow(): TimeWindow {
  const params = useSearchParams();
  return parseTimeWindow(params.get("window"));
}

/**
 * Segmented time-window pill group, rendered on the Ride History tab row
 * (All rides + Road map; hidden on Compare). Persists the selection in the
 * URL as `?window=30d|90d|year|all` via a shallow `router.replace`, keeping
 * any other search params (filters, sort, page) intact.
 */
export function TimeWindowPills() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = parseTimeWindow(params.get("window"));

  const onChange = useCallback(
    (w: TimeWindow) => {
      const next = new URLSearchParams(params.toString());
      if (w === "all") next.delete("window");
      else next.set("window", w);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <div className="inline-flex gap-1.5">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={
            value === o.key
              ? "rounded-full bg-ink px-2.5 py-[5px] text-[11px] font-bold text-cream"
              : "rounded-full border border-line-strong px-2.5 py-[5px] text-[11px] font-bold text-ink transition hover:bg-paper"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
