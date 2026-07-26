"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { SURFACE_COLORS } from "@/components/map/MapCanvas";
import type { RouteQualitySummary } from "@/lib/planner/types";
import { SURFACE_LABELS } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";
import type { Translate } from "@/i18n";

const SURFACE_PERCENT_TOKEN = "\uE000";

export function SurfaceLegendLabel({
  formattedValue,
  surface,
  t,
}: {
  formattedValue: string;
  surface: string;
  t: Translate;
}) {
  // Format one complete catalog message first so translations can reorder the
  // percentage and surface label. The sentinel marks the percentage's final
  // translated position without relying on its text being unique.
  const message = t("{percent} {surface}", {
    percent: SURFACE_PERCENT_TOKEN,
    surface,
  });
  const percentIndex = message.indexOf(SURFACE_PERCENT_TOKEN);
  if (percentIndex < 0) {
    return (
      <>
        {t("{percent} {surface}", {
          percent: formattedValue,
          surface,
        })}
      </>
    );
  }
  const beforePercent = message.slice(0, percentIndex);
  const afterPercent = message.slice(
    percentIndex + SURFACE_PERCENT_TOKEN.length,
  );
  return (
    <>
      {beforePercent}
      <b className="font-bold text-ink">{formattedValue}</b>
      {afterPercent}
    </>
  );
}

/**
 * Surface mix: thin stacked bar + legend (design: Inspect § 02). Colors
 * come from the map's surface palette so the bar matches the
 * surface-colored route line.
 */
export function SurfaceMixBar({
  mix,
}: {
  mix: RouteQualitySummary["surfaceMix"];
}) {
  const t = useTranslation();
  const format = useFormat();
  if (mix.length === 0) return null;
  return (
    <div>
      <div className="mb-2.5 flex h-1.5 overflow-hidden rounded-[3px]">
        {mix.map((entry) => (
          <div
            key={entry.surface}
            style={{
              flexGrow: entry.pct,
              flexBasis: 0,
              background:
                SURFACE_COLORS[entry.surface] ?? SURFACE_COLORS.unknown,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {mix.map((entry) => (
          <span key={entry.surface} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{
                background:
                  SURFACE_COLORS[entry.surface] ?? SURFACE_COLORS.unknown,
              }}
            />
            <span className="text-[11.5px] text-fg-dim">
              <SurfaceLegendLabel
                formattedValue={format.percent(entry.pct / 100)}
                surface={t(SURFACE_LABELS[entry.surface])}
                t={t}
              />
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
