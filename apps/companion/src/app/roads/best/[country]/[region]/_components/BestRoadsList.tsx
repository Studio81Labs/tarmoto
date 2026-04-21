interface Road {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  surface_type: string;
  length_m: number;
  confidence: number;
}

interface Props {
  roads: Road[];
}

function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatQuality(q: number | null): string {
  return q == null ? "—" : q.toFixed(1);
}

export function BestRoadsList({ roads }: Props) {
  if (roads.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400">
        <p className="text-lg font-semibold">Not enough data yet</p>
        <p className="mt-2 text-sm">
          This region needs more rides before we can rank its roads. Take a ride
          through and help build the map.
        </p>
      </div>
    );
  }

  return (
    <ol className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/60">
      {roads.map((r, i) => {
        const name =
          r.road_name ??
          (r.road_number
            ? `Road ${r.road_number}`
            : `Segment ${r.id.slice(0, 6)}`);
        return (
          <li
            key={r.id}
            id={`road-${r.id}`}
            className="flex items-center gap-4 p-4"
          >
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-tarmoto-cyan">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold">{name}</h3>
              <p className="text-xs text-slate-400">
                {formatLength(r.length_m)} · {r.surface_type}
              </p>
            </div>
            <dl className="hidden gap-6 sm:flex">
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  Quality
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {formatQuality(r.quality_score)}
                </dd>
              </div>
              <div className="text-center">
                <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                  Curviness
                </dt>
                <dd className="text-sm font-semibold tabular-nums">
                  {r.curviness_score.toFixed(1)}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ol>
  );
}
