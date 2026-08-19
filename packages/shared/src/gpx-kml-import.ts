/**
 * GPX/KML import (US-20). Platform-agnostic parser shared between the
 * companion (browser) and the mobile app (React Native). Browser-side
 * parsing previously used DOMParser, which does not exist in React Native;
 * this implementation works on raw strings so the same code runs in both
 * environments without polyfills or extra dependencies.
 *
 * Parses files exported from Garmin, Calimoto, Kurviger, Scenic,
 * Google Earth, etc. and turns them into a normalised `ImportedRoute`
 * shape that callers can convert into their own Trip representations.
 */

import { haversineKm } from "./geo";

export type ImportErrorCode =
  | "empty_file"
  | "unsupported_format"
  | "invalid_xml"
  | "gpx_without_route"
  | "kml_without_linestring"
  | "too_few_points";

export type ImportResult =
  { ok: true; route: ImportedRoute } | { ok: false; error: ImportErrorCode };

export interface ImportedRoute {
  name: string;
  sourceFormat: "gpx" | "kml";
  /** [lng, lat] coords, GeoJSON-style. */
  points: Array<[number, number]>;
  waypoints: ImportedWaypoint[];
  totalDistanceKm: number;
}

export interface ImportedWaypoint {
  name?: string;
  lng: number;
  lat: number;
}

const MIN_POINTS = 2;

export function parseImportedRoute(
  text: string,
  filename: string,
): ImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty_file" };

  const stripped = stripCommentsAndCdata(trimmed);
  const format = detectFormat(stripped, filename);
  if (!format) {
    return {
      ok: false,
      error: "unsupported_format",
    };
  }

  if (!isWellFormedEnough(stripped, format)) {
    return { ok: false, error: "invalid_xml" };
  }

  const route =
    format === "gpx"
      ? parseGpx(stripped, filename)
      : parseKml(stripped, filename);
  if (!route) {
    return {
      ok: false,
      error: format === "gpx" ? "gpx_without_route" : "kml_without_linestring",
    };
  }
  if (route.points.length < MIN_POINTS) {
    return { ok: false, error: "too_few_points" };
  }

  return { ok: true, route };
}

function detectFormat(text: string, filename: string): "gpx" | "kml" | null {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".gpx")) return "gpx";
  if (lowerName.endsWith(".kml")) return "kml";
  const head = text.slice(0, 2048).toLowerCase();
  if (head.includes("<gpx")) return "gpx";
  if (head.includes("<kml")) return "kml";
  return null;
}

/**
 * Optional XML namespace prefix. Garmin Connect, Komoot and a handful of
 * KML emitters write `<gpx:trkpt>`, `<kml:LineString>`, etc.; matching
 * tag patterns therefore allow an optional `prefix:` ahead of the local
 * name. Restricted to NCName-ish characters so the regex can't run away
 * across the rest of the line.
 */
const NS_PREFIX_PATTERN = "(?:[A-Za-z_][\\w.-]*:)?";

/**
 * Lightweight well-formedness check. We do not run a full XML validator —
 * that would mean shipping a parser library to RN and the browser. Instead,
 * we check that every opening tag has a corresponding closing or self-close
 * for the structural elements we care about. This catches the cases the
 * companion's old DOMParser flagged as `parsererror` while still tolerating
 * the loose inputs riders actually paste in.
 *
 * `<TAG\b` matches every opener, including self-closing variants like
 * `<rte/>` or `<Placemark/>`. Self-closes are balanced by themselves, so
 * the count of explicit `</TAG>` closers is allowed to fall short by
 * exactly the number of self-closing instances. Earlier revisions
 * required strict open/close pair-matching and rejected valid GPX files
 * that emitted an empty `<rte/>` alongside a populated `<trk>`.
 */
function isWellFormedEnough(text: string, format: "gpx" | "kml"): boolean {
  const root = format;
  const open = new RegExp(`<${NS_PREFIX_PATTERN}${root}\\b`, "i").test(text);
  const close = new RegExp(`</${NS_PREFIX_PATTERN}${root}\\s*>`, "i").test(
    text,
  );
  if (!open || !close) return false;

  const checks =
    format === "gpx"
      ? ["trk", "trkseg", "rte"]
      : ["Document", "Placemark", "LineString"];
  for (const tag of checks) {
    const opens = countMatches(
      text,
      new RegExp(`<${NS_PREFIX_PATTERN}${tag}\\b`, "g"),
    );
    const closes = countMatches(
      text,
      new RegExp(`</${NS_PREFIX_PATTERN}${tag}\\s*>`, "g"),
    );
    const selfCloses = countMatches(
      text,
      new RegExp(`<${NS_PREFIX_PATTERN}${tag}\\b[^>]*?/>`, "g"),
    );
    if (opens !== closes + selfCloses) return false;
  }
  return true;
}

function countMatches(text: string, re: RegExp): number {
  return Array.from(text.matchAll(re)).length;
}

function parseGpx(text: string, filename: string): ImportedRoute | null {
  const trackPoints = collectLatLonElements(text, "trkpt").map(
    (p) => [p.lng, p.lat] as [number, number],
  );
  const routePoints =
    trackPoints.length > 0
      ? []
      : collectLatLonElements(text, "rtept").map(
          (p) => [p.lng, p.lat] as [number, number],
        );
  const points = trackPoints.length > 0 ? trackPoints : routePoints;
  if (points.length === 0) return null;

  const waypoints = collectLatLonElements(text, "wpt");

  const trackName = firstChildText(text, "trk", "name");
  const routeName = firstChildText(text, "rte", "name");
  const metaName = firstChildText(text, "metadata", "name");
  const name =
    trackName ??
    routeName ??
    metaName ??
    stripExtension(filename) ??
    "Imported route";

  return {
    name,
    sourceFormat: "gpx",
    points,
    waypoints,
    totalDistanceKm: pointsDistanceKm(points),
  };
}

function parseKml(text: string, filename: string): ImportedRoute | null {
  const points: Array<[number, number]> = [];
  for (const ls of collectElements(text, "LineString")) {
    const coordsText = childText(ls.body, "coordinates");
    if (!coordsText) continue;
    points.push(...parseKmlCoordString(coordsText));
  }
  if (points.length === 0) return null;

  const waypoints: ImportedWaypoint[] = [];
  for (const placemark of collectElements(text, "Placemark")) {
    if (
      new RegExp(`<${NS_PREFIX_PATTERN}LineString\\b`, "i").test(placemark.body)
    )
      continue;
    const point = collectElements(placemark.body, "Point")[0];
    if (!point) continue;
    const coordsText = childText(point.body, "coordinates");
    if (!coordsText) continue;
    const parsed = parseKmlCoordString(coordsText);
    const first = parsed[0];
    if (!first) continue;
    const wpName = childText(placemark.body, "name");
    waypoints.push({
      ...(wpName != null ? { name: wpName } : {}),
      lng: first[0],
      lat: first[1],
    });
  }

  const docName = firstChildText(text, "Document", "name");
  const firstPlacemark = collectElements(text, "Placemark")[0];
  const firstPlacemarkName = firstPlacemark
    ? childText(firstPlacemark.body, "name")
    : null;
  const name =
    docName ??
    firstPlacemarkName ??
    stripExtension(filename) ??
    "Imported route";

  return {
    name,
    sourceFormat: "kml",
    points,
    waypoints,
    totalDistanceKm: pointsDistanceKm(points),
  };
}

interface ParsedElement {
  attrs: string;
  body: string;
}

/**
 * Scan for occurrences of `<tag ...>body</tag>` or `<tag ... />`. Returns
 * a flat list — nested elements with the same name produce multiple
 * entries. This mimics DOM `getElementsByTagName` for the simple cases
 * the GPX/KML parsers walk. It does not depth-track, so this should only
 * be used on tags that don't nest inside themselves (LineString,
 * Placemark, trk, rte, trkseg — none nest in real exports).
 *
 * Namespace prefixes are accepted on either side and are not required to
 * match each other — DOMParser would treat `<gpx:trk>...</trk>` as
 * malformed but real-world emitters are consistent within a file, and
 * the tighter check would reject more good files than it would catch
 * bad ones.
 */
function collectElements(text: string, tag: string): ParsedElement[] {
  const out: ParsedElement[] = [];
  const openRe = new RegExp(
    `<${NS_PREFIX_PATTERN}${tag}\\b([^>]*?)(/?)>`,
    "gi",
  );
  const closeRe = new RegExp(`</${NS_PREFIX_PATTERN}${tag}\\s*>`, "gi");
  let cursor = 0;
  while (cursor < text.length) {
    openRe.lastIndex = cursor;
    const openMatch = openRe.exec(text);
    if (!openMatch) break;
    const attrs = openMatch[1] ?? "";
    const selfClosed = openMatch[2] === "/";
    if (selfClosed) {
      out.push({ attrs, body: "" });
      cursor = openRe.lastIndex;
      continue;
    }
    const start = openRe.lastIndex;
    closeRe.lastIndex = start;
    const closeMatch = closeRe.exec(text);
    if (!closeMatch) break;
    const body = text.slice(start, closeMatch.index);
    out.push({ attrs, body });
    cursor = closeRe.lastIndex;
  }
  return out;
}

function collectLatLonElements(text: string, tag: string): ImportedWaypoint[] {
  const out: ImportedWaypoint[] = [];
  for (const el of collectElements(text, tag)) {
    const wp = readLatLonAttrs(el);
    if (wp) out.push(wp);
  }
  return out;
}

function readLatLonAttrs(el: ParsedElement): ImportedWaypoint | null {
  const lat = readNumberAttr(el.attrs, "lat");
  const lng = readNumberAttr(el.attrs, "lon");
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const wpName = childText(el.body, "name");
  return {
    ...(wpName != null ? { name: wpName } : {}),
    lat,
    lng,
  };
}

function readNumberAttr(attrs: string, name: string): number | null {
  // Match `name="value"` or `name='value'`. GPX attribute order varies
  // (Garmin emits `lat` before `lon`, some Strava exports flip them) and
  // some emitters use single quotes — handle both.
  const m = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "i"),
  );
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function firstChildText(
  text: string,
  parentTag: string,
  childTag: string,
): string | null {
  const parent = collectElements(text, parentTag)[0];
  if (!parent) return null;
  return childText(parent.body, childTag);
}

/**
 * Look up a direct child element by name and return its text content. Walks
 * the parent body a top-level element at a time so a nested `<trkpt>
 * <name>X</name></trkpt>` can't be confused with a real `<trk><name>`
 * track title — that's the regression an earlier "first match anywhere"
 * regex would produce on GPX files with point-level names.
 *
 * Self-closing matches (`<TAG/>`) return an empty string, which the
 * caller treats as "no usable text" via the trim/empty-string guard.
 * Namespace-prefixed variants (`<gpx:name>`) are accepted on either
 * side per the parser's overall NS-prefix policy.
 */
function childText(body: string, tag: string): string | null {
  // The attrs group MUST be non-greedy — a greedy `[^>]*` would happily
  // swallow the trailing `/` of self-closing tags like `<link href="..."/>`
  // or `<extensions/>`, so the self-close capture always stayed empty and
  // the depth-skip path below would search for a non-existent `</link>`,
  // walk past every later sibling, and miss the target `<name>`. This
  // mirrors the non-greedy form `collectElements` uses for the same
  // reason.
  const tagPattern = new RegExp(
    `^<(/)?(${NS_PREFIX_PATTERN}([A-Za-z_][\\w.-]*))\\b([^>]*?)(/?)>`,
    "i",
  );
  const targetCloseRe = new RegExp(`</${NS_PREFIX_PATTERN}${tag}\\s*>`, "i");

  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    if (lt === -1) break;
    const slice = body.slice(lt);
    const m = tagPattern.exec(slice);
    if (!m) {
      // Bare `<` in text content — skip it.
      i = lt + 1;
      continue;
    }
    const isClose = m[1] === "/";
    const elemName = m[3];
    const isSelfClose = m[5] === "/";
    const tagEnd = lt + m[0].length;

    if (elemName === undefined) {
      // Defensive: the tag-name capture is always present when the pattern
      // matches, but the type is widened by noUncheckedIndexedAccess.
      i = lt + 1;
      continue;
    }

    if (isClose) {
      // We've reached the parent element's own end tag — no direct
      // child by `tag` exists at this level.
      break;
    }

    const matchesTarget = elemName.toLowerCase() === tag.toLowerCase();
    if (matchesTarget) {
      if (isSelfClose) return null;
      const tail = body.slice(tagEnd);
      const closeMatch = targetCloseRe.exec(tail);
      if (!closeMatch) break;
      const inner = decodeXmlEntities(tail.slice(0, closeMatch.index).trim());
      return inner || null;
    }

    if (isSelfClose) {
      i = tagEnd;
      continue;
    }

    // Skip past this non-target child by finding its matching closer
    // for the SAME element name. We track depth so a nested element
    // with the same name (rare in practice but possible) can't fool us.
    const childCloseRe = new RegExp(
      `<(/?)${NS_PREFIX_PATTERN}${elemName}\\b[^>]*?(/?)>`,
      "gi",
    );
    childCloseRe.lastIndex = tagEnd;
    let depth = 1;
    let scanCursor = tagEnd;
    while (depth > 0) {
      const next = childCloseRe.exec(body);
      if (!next) {
        scanCursor = body.length;
        break;
      }
      const nextIsClose = next[1] === "/";
      const nextIsSelfClose = next[2] === "/";
      if (nextIsClose) depth--;
      else if (!nextIsSelfClose) depth++;
      scanCursor = childCloseRe.lastIndex;
    }
    i = scanCursor;
  }
  return null;
}

function parseKmlCoordString(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lngRaw, latRaw] = tuple.split(",");
    if (lngRaw === undefined || latRaw === undefined) continue;
    const lng = Number.parseFloat(lngRaw);
    const lat = Number.parseFloat(latRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push([lng, lat]);
  }
  return out;
}

function stripCommentsAndCdata(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripExtension(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[_-]+/g, " ").trim();
  return cleaned || null;
}

export function pointsDistanceKm(points: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    total += haversineKm(prev[1], prev[0], curr[1], curr[0]);
  }
  return total;
}
