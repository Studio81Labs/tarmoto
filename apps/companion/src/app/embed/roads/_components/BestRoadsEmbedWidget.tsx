import Link from "next/link";
import type { Country, Region } from "@tarmoto/shared";
import {
  projectRoadsToMiniMap,
  type BestRoadsEmbedRoad,
  type BestRoadsWidgetVariant,
} from "@/lib/best-roads-embed";

interface Road extends BestRoadsEmbedRoad {
  road_name: string | null;
  road_number: string | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
}

interface Props {
  country: Country;
  region: Region;
  parent?: Region;
  roads: Road[];
  pageUrl: string;
  variant: BestRoadsWidgetVariant;
}

export function BestRoadsEmbedWidget({
  country,
  region,
  parent,
  roads,
  pageUrl,
  variant,
}: Props) {
  const map = projectRoadsToMiniMap(roads, {
    width: variant === "landscape" ? 720 : 640,
    height: variant === "landscape" ? 240 : 180,
    padding: 18,
  });

  const contentClassName =
    variant === "landscape"
      ? "grid gap-5 md:grid-cols-[1.15fr_0.85fr]"
      : "space-y-5";

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-[24px] border border-slate-800 bg-slate-950 shadow-2xl shadow-black/40">
        <header className="border-b border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.18),_transparent_42%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.98))] px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-tarmoto-cyan">
                Tarmoto widget
              </p>
              <h1 className="mt-2 text-xl font-semibold text-white">
                Best roads in {region.name}
              </h1>
              <p className="mt-1 text-sm text-slate-300">
                {country.name}
                {parent ? ` · ${parent.name}` : ""} · crowdsourced road-quality
                ranking
              </p>
            </div>
            <Link
              href={pageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-full border border-tarmoto-cyan/30 bg-tarmoto-cyan/10 px-3 py-1.5 text-sm font-medium text-tarmoto-cyan transition hover:bg-tarmoto-cyan/15"
            >
              View full map
            </Link>
          </div>
        </header>

        <div className={`p-5 ${contentClassName}`}>
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Road-quality mini-map
                </h2>
                <p className="text-xs text-slate-400">
                  Top-ranked roads in this region, colour-coded by surface
                  quality.
                </p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>{roads.length} ranked roads</p>
                <p>Updated weekly</p>
              </div>
            </div>

            {map.lines.length === 0 ? (
              <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-950/80 text-sm text-slate-500">
                Not enough road geometry yet for a mini-map preview.
              </div>
            ) : (
              <svg
                viewBox={map.viewBox}
                role="img"
                aria-label={`Mini-map of the best motorcycle roads in ${region.name}`}
                className="h-auto w-full rounded-xl bg-[linear-gradient(180deg,_rgba(15,23,42,0.94),_rgba(2,6,23,1))]"
              >
                <rect width="100%" height="100%" fill="transparent" />
                {map.lines.map((line) => (
                  <polyline
                    key={line.id}
                    points={line.points.map(([x, y]) => `${x},${y}`).join(" ")}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.96}
                  />
                ))}
                {map.markers.map((marker) => (
                  <g
                    key={marker.id}
                    transform={`translate(${marker.x}, ${marker.y})`}
                  >
                    <circle
                      r="14"
                      fill="#020617"
                      stroke={marker.color}
                      strokeWidth="3"
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#F8FAFC"
                      fontSize="12"
                      fontWeight="700"
                    >
                      {marker.rank}
                    </text>
                  </g>
                ))}
              </svg>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Top roads</h2>
                <p className="text-xs text-slate-400">
                  Ranked by the current quality and curviness model.
                </p>
              </div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Live preview
              </p>
            </div>

            <ol className="space-y-2">
              {roads
                .slice(0, variant === "landscape" ? 4 : 3)
                .map((road, index) => (
                  <li
                    key={road.id}
                    className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2.5"
                  >
                    <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-tarmoto-cyan">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">
                        {roadLabel(road)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatLength(road.length_m)} · {road.surface_type} ·
                        quality {formatQuality(road.quality_score)}
                      </p>
                    </div>
                    <p className="text-xs font-semibold text-slate-300">
                      {road.curviness_score.toFixed(1)}
                    </p>
                  </li>
                ))}
            </ol>
          </section>
        </div>
      </article>
    </main>
  );
}

function roadLabel(road: Road): string {
  return (
    road.road_name ??
    (road.road_number
      ? `Road ${road.road_number}`
      : `Segment ${road.id.slice(0, 6)}`)
  );
}

function formatLength(lengthM: number): string {
  return lengthM >= 1000
    ? `${(lengthM / 1000).toFixed(1)} km`
    : `${Math.round(lengthM)} m`;
}

function formatQuality(qualityScore: number | null): string {
  return qualityScore == null ? "—" : qualityScore.toFixed(1);
}
