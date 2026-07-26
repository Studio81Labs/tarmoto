"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { SURFACE_COLORS } from "@/components/map/MapCanvas";
import type { RouteQualitySummary } from "@/lib/planner/types";
import { SURFACE_LABELS } from "@/lib/utils";
import { useFormat } from "@/format/FormatProvider";
import type { Translate } from "@/i18n";
import { LocalizedStyledValue } from "@/i18n/LocalizedStyledValue";

export function SurfaceLegendLabel({
  formattedValue,
  surface,
  t,
}: {
  formattedValue: string;
  surface: string;
  t: Translate;
}) {
  return (
    <LocalizedStyledValue
      t={t}
      messageKey="{percent} {surface}"
      values={{ surface }}
      valueName="percent"
      formattedValue={formattedValue}
      className="font-bold text-ink"
      as="b"
    />
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
