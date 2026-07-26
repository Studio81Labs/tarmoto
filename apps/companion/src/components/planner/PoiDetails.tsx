import type { ReactNode } from "react";
import {
  Clock,
  Globe,
  MapPin,
  Mountain,
  Phone,
  Star,
  Tag,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "@/i18n/I18nProvider";
import type { Poi } from "@/lib/planner/types";
import type { PassStatus } from "@/lib/passes-summary";
import { useFormat } from "@/format/FormatProvider";
import { PASS_STATUS_LABELS } from "@/i18n/domainLabels";

/**
 * Decision-support fields a POI can carry: OSM tags for store-backed POIs
 * (#849) plus seasonal status + elevation for `mountain_pass` POIs (#865).
 * `readPoiDetails` always returns every key; each is `undefined` when absent
 * (OSM nodes are sparsely tagged; the pass fields only apply to passes), so
 * callers gate on `!== undefined`.
 */
export interface PoiDetailFields {
  /** Accommodation star rating (OSM `stars`), 1–5. */
  stars: number | undefined;
  /** Raw OSM `opening_hours` string, e.g. `Mo-Fr 08:00-18:00`. */
  openingHours: string | undefined;
  addressStreet: string | undefined;
  addressCity: string | undefined;
  phone: string | undefined;
  website: string | undefined;
  /** OSM `cuisine` (food venues). */
  cuisine: string | undefined;
  /** OSM `brand`/operator (fuel, chains). */
  brand: string | undefined;
  /** Seasonal open/closed/unknown status — `mountain_pass` only (#865). */
  passStatus: PassStatus | undefined;
  /** Summit elevation in metres — `mountain_pass` only (#865). */
  elevationM: number | undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * OSM `website` tags are unnormalized — a bare host (`www.x.example`), a full
 * `https://…`, or occasionally a non-web scheme. Return an absolute http(s)
 * URL (assuming https for scheme-less values) or `undefined` for anything we
 * can't safely turn into an href: a scheme-less value would otherwise resolve
 * against the companion origin, and `javascript:` / `mailto:` etc. must never
 * become a link target.
 */
function safeWebsiteUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    // No scheme — assume https and re-validate below.
  }
  try {
    const parsed = new URL(`https://${raw}`);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function passStatusOf(meta: Record<string, unknown>): PassStatus | undefined {
  return meta.status === "open" ||
    meta.status === "closed" ||
    meta.status === "unknown"
    ? meta.status
    : undefined;
}

/**
 * Pull the decision-support fields off a POI's `meta` bag with type guards:
 * OSM tags for store-backed POIs, plus seasonal status + elevation for a
 * `mountain_pass` (#865). The pass fields are gated on the category so a stray
 * `status`/`elevationM` on some other POI is ignored; a twisty highlight's
 * `twistyScore` matches nothing here and renders no details.
 */
export function readPoiDetails(poi: Poi): PoiDetailFields {
  const meta = poi.meta ?? {};
  const website = nonEmptyString(meta.website);
  const isPass = poi.category === "mountain_pass";
  return {
    stars: typeof meta.stars === "number" ? meta.stars : undefined,
    openingHours: nonEmptyString(meta.openingHours),
    addressStreet: nonEmptyString(meta.addressStreet),
    addressCity: nonEmptyString(meta.addressCity),
    phone: nonEmptyString(meta.phone),
    website: website ? safeWebsiteUrl(website) : undefined,
    cuisine: nonEmptyString(meta.cuisine),
    brand: nonEmptyString(meta.brand),
    passStatus: isPass ? passStatusOf(meta) : undefined,
    elevationM:
      isPass && typeof meta.elevationM === "number"
        ? meta.elevationM
        : undefined,
  };
}

/** True when at least one decision-support field is present. */
export function hasPoiDetails(d: PoiDetailFields): boolean {
  return (
    d.stars !== undefined ||
    d.openingHours !== undefined ||
    d.addressStreet !== undefined ||
    d.addressCity !== undefined ||
    d.phone !== undefined ||
    d.website !== undefined ||
    d.cuisine !== undefined ||
    d.brand !== undefined ||
    d.passStatus !== undefined ||
    d.elevationM !== undefined
  );
}

// Mirrors PassesPanel's status colours + labels so a pass reads consistently
// across the planner: the passes list, the map legend, and this POI popover.
// Both surfaces share the cataloged PASS_STATUS_LABELS map.
const PASS_STATUS_DOT: Record<PassStatus, string> = {
  open: "bg-[#1f8a5b]",
  closed: "bg-quality-q1",
  unknown: "bg-ink/40",
};

/** Strip protocol + leading `www.` + trailing slash for a compact label. */
function displayHost(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function DetailRow({
  icon: Icon,
  clamp,
  children,
}: {
  icon: LucideIcon;
  /** Cap at two lines — used for free-form OSM strings that can run long. */
  clamp?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5 text-[11.5px] leading-tight text-ink">
      <Icon size={12} className="mt-[1px] shrink-0 text-fg-mute" />
      <span className={`min-w-0 break-words${clamp ? " line-clamp-2" : ""}`}>
        {children}
      </span>
    </div>
  );
}

/**
 * POI decision-support rows: a `mountain_pass`'s seasonal status + elevation
 * (#865), then store-backed OSM fields (#849) — star rating, cuisine/brand,
 * opening hours, address, phone and website — whatever the row carries. The
 * `pois` mirror populates the OSM fields; a twisty highlight and sparsely-tagged
 * nodes render nothing.
 */
export function PoiDetails({ poi }: { poi: Poi }) {
  const t = useTranslation();
  const format = useFormat();
  const d = readPoiDetails(poi);
  if (!hasPoiDetails(d)) return null;
  const address = [d.addressStreet, d.addressCity].filter(Boolean).join(", ");
  return (
    <div className="mb-1.5 flex flex-col gap-1 border-t border-line px-1.5 pt-2">
      {d.passStatus ? (
        <div className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ink">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${PASS_STATUS_DOT[d.passStatus]}`}
          />
          <span className="min-w-0 break-words">
            {t(PASS_STATUS_LABELS[d.passStatus])}
          </span>
        </div>
      ) : null}
      {d.elevationM !== undefined ? (
        <DetailRow icon={Mountain}>{format.elevation(d.elevationM)}</DetailRow>
      ) : null}
      {d.stars !== undefined ? (
        <DetailRow icon={Star}>
          {t("{stars}-star", { stars: d.stars })}
        </DetailRow>
      ) : null}
      {d.cuisine ? (
        <DetailRow icon={Utensils}>{d.cuisine}</DetailRow>
      ) : d.brand ? (
        <DetailRow icon={Tag}>{d.brand}</DetailRow>
      ) : null}
      {d.openingHours ? (
        <DetailRow icon={Clock} clamp>
          {d.openingHours}
        </DetailRow>
      ) : null}
      {address ? <DetailRow icon={MapPin}>{address}</DetailRow> : null}
      {d.phone ? (
        <a
          href={`tel:${d.phone.replace(/\s+/g, "")}`}
          className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ink transition hover:text-accent"
        >
          <Phone size={12} className="shrink-0 text-fg-mute" />
          <span className="min-w-0 break-words">{d.phone}</span>
        </a>
      ) : null}
      {d.website ? (
        <a
          href={d.website}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ink transition hover:text-accent"
        >
          <Globe size={12} className="shrink-0 text-fg-mute" />
          <span className="min-w-0 truncate">{displayHost(d.website)}</span>
        </a>
      ) : null}
    </div>
  );
}
