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

export type ImportResult =
  | { ok: true; route: ImportedRoute }
  | { ok: false; error: string };

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
  if (!trimmed) return { ok: false, error: "File is empty." };

  const stripped = stripCommentsAndCdata(trimmed);
  const format = detectFormat(stripped, filename);
  if (!format) {
    return {
      ok: false,
      error: "Unsupported file format. Upload a GPX or KML file.",
    };
  }

  if (!isWellFormedEnough(stripped, format)) {
    return { ok: false, error: "File is not valid XML." };
  }

  const route =
    format === "gpx"
      ? parseGpx(stripped, filename)
      : parseKml(stripped, filename);
  if (!route) {
    return {
      ok: false,
      error:
        format === "gpx"
          ? "GPX file has no track or route points."
          : "KML file has no LineString coordinates.",
    };
  }
  if (route.points.length < MIN_POINTS) {
    return { ok: false, error: "Route needs at least two points." };
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
    if (opens !== closes) return false;
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
    waypoints.push({
      name: childText(placemark.body, "name") ?? undefined,
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
  return {
    name: childText(el.body, "name") ?? undefined,
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

function childText(body: string, tag: string): string | null {
  // We deliberately match the FIRST occurrence anywhere inside the body
  // rather than only direct children — DOM tree-walks are out of scope
  // for a regex parser, and in practice the first `<name>` inside a
  // `<trk>` / `<wpt>` / `<Placemark>` is the title we want. The optional
  // namespace prefix matches Garmin/Komoot-style `<gpx:name>`.
  const m = body.match(
    new RegExp(
      `<${NS_PREFIX_PATTERN}${tag}\\b[^>]*>([\\s\\S]*?)</${NS_PREFIX_PATTERN}${tag}\\s*>`,
      "i",
    ),
  );
  if (!m) return null;
  const inner = decodeXmlEntities(m[1].trim());
  return inner || null;
}

function parseKmlCoordString(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lngRaw, latRaw] = tuple.split(",");
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
    total += haversineKm(
      points[i - 1][1],
      points[i - 1][0],
      points[i][1],
      points[i][0],
    );
  }
  return total;
}
