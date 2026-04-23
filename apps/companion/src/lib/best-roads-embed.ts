export type BestRoadsWidgetVariant = "compact" | "landscape";

export interface BestRoadsEmbedLocation {
  country: string;
  region: string;
  subregion?: string;
}

export interface BestRoadsEmbedRoad {
  id: string;
  quality_score: number | null;
  geometry: Array<{ lat: number; lng: number }>;
}

interface WidgetDimensions {
  heightPx: number;
}

interface MiniMapOptions {
  width: number;
  height: number;
  padding: number;
}

interface MiniMapLine {
  id: string;
  rank: number;
  color: string;
  points: Array<[number, number]>;
}

interface MiniMapMarker {
  id: string;
  rank: number;
  color: string;
  x: number;
  y: number;
}

interface MiniMapProjection {
  viewBox: string;
  lines: MiniMapLine[];
  markers: MiniMapMarker[];
}

export function buildBestRoadsEmbedUrl(
  origin: string,
  location: BestRoadsEmbedLocation & { variant?: BestRoadsWidgetVariant },
): string {
  const base = origin.replace(/\/$/, "");
  const path = location.subregion
    ? `/embed/roads/${encodeURIComponent(location.country)}/${encodeURIComponent(location.region)}/${encodeURIComponent(location.subregion)}`
    : `/embed/roads/${encodeURIComponent(location.country)}/${encodeURIComponent(location.region)}`;
  const variant = location.variant ?? "compact";
  return `${base}${path}?variant=${variant}`;
}

export function buildBestRoadsIframeCode(
  origin: string,
  options: BestRoadsEmbedLocation & {
    regionName: string;
    variant?: BestRoadsWidgetVariant;
  },
): string {
  const variant = options.variant ?? "compact";
  const heightPx = widgetDimensions(variant).heightPx;
  const src = buildBestRoadsEmbedUrl(origin, { ...options, variant });
  const title = `Tarmoto best roads widget for ${options.regionName}`;

  return [
    `<iframe`,
    `  src="${src}"`,
    `  title="${title}"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin-when-cross-origin"`,
    `  style="width:100%;max-width:960px;height:${heightPx}px;border:0;overflow:hidden;border-radius:16px;"`,
    `></iframe>`,
  ].join("\n");
}

export function projectRoadsToMiniMap(
  roads: BestRoadsEmbedRoad[],
  options: MiniMapOptions,
): MiniMapProjection {
  const validRoads = roads
    .filter((road) => road.geometry.length >= 2)
    .map((road, index) => ({
      id: road.id,
      rank: index + 1,
      color: qualityColor(road.quality_score),
      geometry: road.geometry,
    }));

  if (validRoads.length === 0) {
    return {
      viewBox: `0 0 ${options.width} ${options.height}`,
      lines: [],
      markers: [],
    };
  }

  const lats = validRoads.flatMap((road) =>
    road.geometry.map((point) => point.lat),
  );
  const lngs = validRoads.flatMap((road) =>
    road.geometry.map((point) => point.lng),
  );
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const innerWidth = Math.max(options.width - options.padding * 2, 1);
  const innerHeight = Math.max(options.height - options.padding * 2, 1);
  const lngSpan = Math.max(maxLng - minLng, 0.000001);
  const latSpan = Math.max(maxLat - minLat, 0.000001);

  const project = (lng: number, lat: number): [number, number] => {
    const x = options.padding + ((lng - minLng) / lngSpan) * innerWidth;
    const y = options.padding + ((maxLat - lat) / latSpan) * innerHeight;
    return [round(x), round(y)];
  };

  const lines = validRoads.map((road) => ({
    id: road.id,
    rank: road.rank,
    color: road.color,
    points: road.geometry.map((point) => project(point.lng, point.lat)),
  }));

  const markers = validRoads.map((road) => {
    const midpoint = road.geometry[Math.floor(road.geometry.length / 2)]!;
    const [x, y] = project(midpoint.lng, midpoint.lat);
    return { id: road.id, rank: road.rank, color: road.color, x, y };
  });

  return {
    viewBox: `0 0 ${options.width} ${options.height}`,
    lines,
    markers,
  };
}

export function widgetHeightPx(variant: BestRoadsWidgetVariant): number {
  return widgetDimensions(variant).heightPx;
}

function widgetDimensions(variant: BestRoadsWidgetVariant): WidgetDimensions {
  if (variant === "landscape") return { heightPx: 420 };
  return { heightPx: 320 };
}

function qualityColor(qualityScore: number | null): string {
  if (qualityScore == null) return "#64748B";
  if (qualityScore >= 4.5) return "#22C55E";
  if (qualityScore >= 3.5) return "#84CC16";
  if (qualityScore >= 2.5) return "#EAB308";
  if (qualityScore >= 1.5) return "#F97316";
  return "#EF4444";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
