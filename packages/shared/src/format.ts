/**
 * Locale-aware display formatting.
 *
 * `createFormatters` (added alongside these validators) is the single
 * formatting seam for client surfaces. The validators here are shared by
 * the backend DTO layer and the companion capture route so both sides
 * accept exactly the same `format_locale` / `timezone` values.
 */

export const DEFAULT_FORMAT_LOCALE = "en";
/** BCP-47 tags are bounded well under this; also caps abuse via the wire. */
export const FORMAT_LOCALE_MAX_LENGTH = 35;
/** Matches the varchar(64) shape of `quiet_hours_timezone`. */
export const TIMEZONE_MAX_LENGTH = 64;

/**
 * Returns the canonical BCP-47 form of a locale tag ("CS-cz" → "cs-CZ"),
 * or null when the input is not a well-formed tag. Never throws — cookie
 * and wire input are untrusted.
 */
export function canonicalizeFormatLocale(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed || trimmed.length > FORMAT_LOCALE_MAX_LENGTH) return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

export function isValidFormatLocale(tag: unknown): tag is string {
  return canonicalizeFormatLocale(tag) !== null;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (
    typeof zone !== "string" ||
    zone === "" ||
    zone.length > TIMEZONE_MAX_LENGTH
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat(DEFAULT_FORMAT_LOCALE, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the highest-q usable locale tag from an Accept-Language header,
 * keeping the region. Unlike `resolveLocale` (i18n.ts), which reduces to a
 * primary subtag for catalog lookup, "cs-CZ" must stay "cs-CZ" here —
 * number/date formats differ per region, not just per language.
 */
export function resolveFormatLocaleFromAcceptLanguage(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag: (tag ?? "").trim(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((candidate) => candidate.tag !== "" && candidate.tag !== "*")
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    const canonical = canonicalizeFormatLocale(candidate.tag);
    if (canonical) return canonical;
  }
  return null;
}
