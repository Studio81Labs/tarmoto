import { Fragment } from "react";
import {
  AlertTriangle,
  CloudSun,
  Fuel,
  MapPin,
  Mountain,
  Route as RouteIcon,
  Timer,
} from "lucide-react";
import {
  buildDayElevationProfile,
  groupDayWaypoints,
  pickAppendixSegments,
  type WaypointGroup,
} from "@/lib/trip-export";
import { buildRoutePreview } from "@/lib/ride-detail";
import { QUALITY_CONFIG, formatDistance, formatDuration } from "@/lib/utils";
import type { TripDetailMember } from "@/lib/trip-from-detail";
import type { RoutePreviewSegment, Trip, TripDay } from "@/lib/types";

interface TripPrintBodyProps {
  trip: Trip;
  region?: string;
  members?: TripDetailMember[];
}

/**
 * Print-only body shared by `/trips/[tripId]/print` and the planner's
 * `/trips/planner/print` page (US-39). Renders a cover page, one section
 * per day with route map snapshot + elevation sparkline + grouped
 * waypoints + weather caveat, and an appendix with the highest-scoring
 * road preview cards. CSS page-breaks land each day on its own A4 sheet
 * so the PDF stays scannable in the rider's tank bag.
 */
export function TripPrintBody({ trip, region, members }: TripPrintBodyProps) {
  const totals = trip.days.reduce(
    (acc, day) => ({
      distanceKm: acc.distanceKm + (day.distanceKm ?? 0),
      durationMinutes: acc.durationMinutes + (day.durationMinutes ?? 0),
      elevationGain: acc.elevationGain + (day.elevationGain ?? 0),
    }),
    { distanceKm: 0, durationMinutes: 0, elevationGain: 0 },
  );

  const appendixSegments = pickAppendixSegments(trip);

  return (
    <article className="trip-print-body mx-auto max-w-3xl px-6 py-8 text-[14px] leading-relaxed">
      {/*
        Print CSS lives with the body (not the host page) so the rules
        stay in lockstep with the class names this component renders.
        The `.trip-print-toolbar` rule is the public contract for hosts:
        any wrapper that puts a toolbar over this body should tag it
        with that class so it's hidden on paper.
      */}
      <style>{`
        @media print {
          .trip-print-toolbar { display: none !important; }
          @page { size: A4; margin: 16mm; }
          .trip-print-cover { page-break-after: always; }
          .trip-print-day { page-break-inside: avoid; page-break-before: always; }
          .trip-print-day:first-child { page-break-before: auto; }
          .trip-print-appendix { page-break-before: always; }
        }
      `}</style>

      <CoverSection
        trip={trip}
        region={region}
        totals={totals}
        members={members ?? []}
      />

      <ol className="space-y-0">
        {trip.days.map((day) => (
          <li
            key={day.dayNumber}
            className="trip-print-day border-t border-slate-200 pt-6 mt-6 first:border-t-0 first:pt-0 first:mt-0"
          >
            <DaySection day={day} />
          </li>
        ))}
      </ol>

      {appendixSegments.length > 0 && (
        <section className="trip-print-appendix border-t border-slate-200 pt-6 mt-6">
          <h2 className="text-lg font-semibold mb-4">
            Road preview cards · top {appendixSegments.length}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {appendixSegments.map((segment) => (
              <SegmentCard key={segment.id} segment={segment} />
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-slate-200 pt-4 mt-6 text-xs text-slate-500">
        <p>
          Generated with Tarmoto Companion · {new Date().toLocaleDateString()}
        </p>
      </footer>
    </article>
  );
}

function CoverSection({
  trip,
  region,
  totals,
  members,
}: {
  trip: Trip;
  region: string | undefined;
  totals: {
    distanceKm: number;
    durationMinutes: number;
    elevationGain: number;
  };
  members: TripDetailMember[];
}) {
  return (
    <header className="trip-print-cover">
      <p className="text-xs uppercase tracking-widest text-slate-500">
        Tarmoto trip plan
      </p>
      <h1 className="text-3xl font-bold mt-1">{trip.name}</h1>
      {trip.description && (
        <p className="mt-2 text-slate-600">{trip.description}</p>
      )}
      {region && (
        <p className="mt-1 text-sm text-slate-600">Region: {region}</p>
      )}

      <dl className="mt-4 grid grid-cols-4 gap-4 text-sm">
        <CoverStat
          label="Days"
          value={String(trip.days.length)}
          icon={<RouteIcon size={14} className="text-slate-500" />}
        />
        <CoverStat
          label="Total distance"
          value={formatDistance(totals.distanceKm)}
          icon={<RouteIcon size={14} className="text-slate-500" />}
        />
        <CoverStat
          label="Riding time"
          value={
            totals.durationMinutes > 0
              ? formatDuration(totals.durationMinutes)
              : "—"
          }
          icon={<Timer size={14} className="text-slate-500" />}
        />
        <CoverStat
          label="Elevation gain"
          value={
            totals.elevationGain > 0
              ? `${Math.round(totals.elevationGain)} m`
              : "—"
          }
          icon={<Mountain size={14} className="text-slate-500" />}
        />
      </dl>

      {members.length > 0 && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold text-slate-700">Members</h2>
          <ul className="mt-1.5 space-y-0.5 text-sm text-slate-700">
            {members.map((m) => (
              <li key={m.user_id}>
                {m.display_name}{" "}
                <span className="text-xs uppercase tracking-wide text-slate-500">
                  · {m.role}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </header>
  );
}

function CoverStat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-slate-500 flex items-center gap-1.5">
        {icon}
        {label}
      </dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DaySection({ day }: { day: TripDay }) {
  const groups = groupDayWaypoints(day);
  const elevationProfile = buildDayElevationProfile(day);
  // Prefer the routed geometry; fall back to waypoint coords when the
  // day doesn't have a routed line (e.g. an imported GPX without a
  // smoothed route, or a planner draft pre-route-solve).
  const previewGeometry = day.routeGeometry?.coordinates?.length
    ? day.routeGeometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
    : day.waypoints.map((w) => ({
        lat: w.location.lat,
        lng: w.location.lng,
      }));
  const preview = buildRoutePreview(previewGeometry, 480, 6);

  return (
    <article>
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-base font-semibold">
          Day {day.dayNumber}
          {day.title && (
            <span className="text-slate-500 font-normal"> — {day.title}</span>
          )}
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {formatDistance(day.distanceKm ?? 0)}
          {day.durationMinutes > 0 && (
            <> · {formatDuration(day.durationMinutes)}</>
          )}
          {day.elevationGain > 0 && <> · {Math.round(day.elevationGain)} m ↑</>}
        </span>
      </header>

      {preview ? (
        <figure className="trip-print-map mb-4 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          <svg
            viewBox={preview.viewBox}
            role="img"
            aria-label={`Day ${day.dayNumber} route preview`}
            className="block h-auto w-full"
          >
            <path
              d={preview.path}
              fill="none"
              stroke="#0f172a"
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        </figure>
      ) : null}

      {elevationProfile && <ElevationSparkline points={elevationProfile} />}

      {groups.length === 0 ? (
        <p className="text-xs text-slate-500">No waypoints for this day.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <WaypointGroupBlock key={group.label} group={group} />
          ))}
        </div>
      )}

      <p className="trip-print-caveat mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <CloudSun size={14} className="mt-0.5 shrink-0" />
        <span>
          Check the local weather forecast on the morning of the ride — Alpine
          and coastal sections can swing from sun to thunderstorms in a few
          hours. If high winds, ice, or heavy rain are forecast, reconsider the
          route.
        </span>
      </p>
    </article>
  );
}

function ElevationSparkline({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(max - min, 1);
  const width = 480;
  const height = 60;
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const path = points
    .map((value, index) => {
      const x = (index * stepX).toFixed(2);
      const y = (height - ((value - min) / range) * height).toFixed(2);
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
  return (
    <figure className="trip-print-elev mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <figcaption className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
        Elevation · {Math.round(min)}–{Math.round(max)} m
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Elevation profile"
        preserveAspectRatio="none"
        className="block h-12 w-full"
      >
        <path
          d={path}
          fill="none"
          stroke="#0f172a"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </figure>
  );
}

function WaypointGroupBlock({ group }: { group: WaypointGroup }) {
  const Icon = groupIcon(group.label);
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs uppercase tracking-wider text-slate-600">
        <Icon size={12} />
        {group.label}
      </h3>
      <ul className="space-y-1">
        {group.waypoints.map((wp, idx) => (
          <li
            key={`${wp.label}-${idx}`}
            className="flex items-baseline gap-3 text-sm"
          >
            <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-slate-500">
              {wp.typeLabel}
            </span>
            <span className="flex-1 font-medium">{wp.label}</span>
            <span className="tabular-nums text-xs text-slate-500">
              {wp.lat.toFixed(4)}, {wp.lng.toFixed(4)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function groupIcon(label: string) {
  if (label === "Fuel") return Fuel;
  if (label === "Accommodation") return MapPin;
  return MapPin;
}

function SegmentCard({ segment }: { segment: RoutePreviewSegment }) {
  const tierMeta = QUALITY_CONFIG[segment.qualityTier];
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-3">
      <header className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold truncate">
          {segment.name ?? `Segment ${segment.id.slice(0, 6)}`}
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          Day {segment.dayNumber}
        </span>
      </header>
      <dl className="grid grid-cols-3 gap-1.5 text-[11px] text-slate-600">
        <Fragment>
          <div>
            <dt className="text-slate-500">Quality</dt>
            <dd
              className="font-semibold tabular-nums"
              style={{ color: tierMeta?.hex ?? undefined }}
            >
              {segment.qualityScore.toFixed(1)}
              {tierMeta && (
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  · {tierMeta.label}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Distance</dt>
            <dd className="font-semibold tabular-nums">
              {formatDistance(segment.distanceKm)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Curves</dt>
            <dd className="font-semibold tabular-nums">
              {Math.round(segment.curvinessScore)}/100
            </dd>
          </div>
        </Fragment>
      </dl>
      {segment.activeHazards.length > 0 && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-700">
          <AlertTriangle size={11} />
          {segment.activeHazards.length} active hazard
          {segment.activeHazards.length === 1 ? "" : "s"}
        </p>
      )}
    </article>
  );
}
