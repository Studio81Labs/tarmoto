"use client";

import { t } from "@/i18n";
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SegmentedControl, type SegmentedOption } from "@tarmoto/ui";

export type TimeWindow = "all" | "year" | "90d" | "30d";

const OPTIONS: SegmentedOption<TimeWindow>[] = [
  { value: "all", label: "All time" },
  { value: "year", label: "This year" },
  { value: "90d", label: "Last 90 days" },
  { value: "30d", label: "Last 30 days" },
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
 * other filter/sort params intact but resetting pagination (the window is
 * itself a filter, so a stale `page` offset may have no rows under the new
 * bound).
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
      // The window is a filter; a stale page offset can land on an empty
      // page even when matching rides exist on page 1. Reset to page 1.
      next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <SegmentedControl
      ariaLabel={t("Time window")}
      value={value}
      onChange={onChange}
      options={OPTIONS.map((opt) => ({ ...opt, label: t(opt.label) }))}
    />
  );
}
