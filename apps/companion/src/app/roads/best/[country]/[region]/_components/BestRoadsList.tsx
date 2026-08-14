import { t } from "@/i18n/server";
import type { BestRoad } from "@/lib/bestRoads";
import {
  formatRoadLabel,
  formatRoadLength,
  formatRoadQuality,
} from "@/lib/best-roads-format";
import { getServerFormatters } from "@/format/server";
import { surfaceTypeLabel } from "@/lib/utils";
type Road = Pick<
  BestRoad,
  | "id"
  | "road_name"
  | "road_number"
  | "curviness_score"
  | "surface_type"
  | "length_m"
  | "confidence"
> & {
  /** Absent when `road_quality_overlay` is killed — see BestRoadsPageBody. */
  quality_score?: number | null;
};
interface Props {
  roads: Road[];
}
export async function BestRoadsList({ roads }: Props) {
  const format = await getServerFormatters();
  if (roads.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-paper p-8 text-center text-fg-dim">
        <p className="text-lg font-semibold">{t("Not enough data yet")}</p>
        <p className="mt-2 text-sm">
          {t(
            "This region needs more rides before we can rank its roads. Take a ride through and help build the map.",
          )}
        </p>
      </div>
    );
  }
  return (
    <ol className="divide-y divide-line rounded-xl border border-line bg-paper">
      {roads.map((r, i) => {
        return (
          <li
            key={r.id}
            id={`road-${r.id}`}
            className="flex items-center gap-4 p-4"
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-cream">
              {format.number(i + 1, {
                useGrouping: false,
                maximumFractionDigits: 0,
              })}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold">
                {formatRoadLabel(r, t)}
              </h3>
              <p className="text-xs text-fg-dim">
                {formatRoadLength(r.length_m, format)} ·{" "}
                {t(surfaceTypeLabel(r.surface_type))}
              </p>
            </div>
            <dl className="hidden gap-6 sm:flex">
              {/* Omit the whole cell when the operator has killed the overlay
                  — an em dash where a score used to be still tells a visitor
                  the figure exists and is being withheld. Curviness and
                  distance carry the row on their own, so there is nothing to
                  404 over. */}
              {r.quality_score !== undefined ? (
                <div className="text-center">
                  <dt className="text-[10px] uppercase tracking-wider text-fg-dim">
                    {t("Quality")}
                  </dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {formatRoadQuality(r.quality_score, format)}
                  </dd>
                </div>
              ) : null}
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-fg-dim">
                  {t("Curviness")}
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {format.decimal(r.curviness_score, 1)}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
