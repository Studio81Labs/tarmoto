import type { ReactNode } from "react";
import {
  Clock,
  Globe,
  MapPin,
  Phone,
  Star,
  Tag,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { t } from "@/i18n";
import type { Poi } from "@/lib/planner/types";

/**
 * Decision-support fields a store-backed POI can carry (#849). `readPoiDetails`
 * always returns every key; each is `undefined` when the underlying OSM tag is
 * absent (nodes are sparsely tagged), so callers gate on `!== undefined`.
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

/**
 * Pull the decision-support fields off a store-backed POI's `meta` bag with
 * type guards. Mock passes / twisties carry unrelated `meta` keys (twisty
 * score, elevation, pass status) — those don't match and are ignored, so the
 * details block renders nothing for them.
 */
export function readPoiDetails(poi: Poi): PoiDetailFields {
  const meta = poi.meta ?? {};
  const website = nonEmptyString(meta.website);
  return {
    stars: typeof meta.stars === "number" ? meta.stars : undefined,
    openingHours: nonEmptyString(meta.openingHours),
    addressStreet: nonEmptyString(meta.addressStreet),
    addressCity: nonEmptyString(meta.addressCity),
    phone: nonEmptyString(meta.phone),
    website: website ? safeWebsiteUrl(website) : undefined,
    cuisine: nonEmptyString(meta.cuisine),
    brand: nonEmptyString(meta.brand),
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
    d.brand !== undefined
  );
}

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
 * Store-backed POI decision-support rows (#849): star rating, cuisine/brand,
 * opening hours, address, phone and website — whatever the row carries. The
 * `pois` mirror populates these on OSM-sourced POIs; mock passes / twisties
 * and sparsely-tagged nodes render nothing.
 */
export function PoiDetails({ poi }: { poi: Poi }) {
  const d = readPoiDetails(poi);
  if (!hasPoiDetails(d)) return null;
  const address = [d.addressStreet, d.addressCity].filter(Boolean).join(", ");
  return (
    <div className="mb-1.5 flex flex-col gap-1 border-t border-line px-1.5 pt-2">
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
