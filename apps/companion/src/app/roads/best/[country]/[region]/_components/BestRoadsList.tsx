import { t } from "@/i18n";
import type { BestRoad } from "@/lib/bestRoads";
import {
  formatRoadLabel,
  formatRoadLength,
  formatRoadQuality,
} from "@/lib/best-roads-format";
import { getServerFormatters } from "@/format/server";
type Road = Pick<
  BestRoad,
  | "id"
  | "road_name"
  | "road_number"
  | "quality_score"
  | "curviness_score"
  | "surface_type"
  | "length_m"
  | "confidence"
>;
interface Props {
  roads: Road[];
}
export async function BestRoadsList({ roads }: Props) {
  const format = await getServerFormatters();
  if (roads.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400">
        <p className="text-lg font-semibold">{t("Not enough data yet")}</p>
        <p className="mt-2 text-sm">
          {t(
            "This region needs more rides before we can rank its roads. Take a ride through and help build the map. ",
          )}
        </p>
      </div>
    );
  }
  return (
    <ol className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
      {roads.map((r, i) => {
        return (
          <li
            key={r.id}
            id={`road-${r.id}`}
            className="flex items-center gap-4 p-4"
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-accent">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold">{formatRoadLabel(r)}</h3>
              <p className="text-xs text-slate-400">
                {formatRoadLength(r.length_m, format)} · {r.surface_type}
              </p>
            </div>
            <dl className="hidden gap-6 sm:flex">
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  {t("Quality ")}
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {formatRoadQuality(r.quality_score, format)}
                </dd>
              </div>
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  {t("Curviness ")}
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
