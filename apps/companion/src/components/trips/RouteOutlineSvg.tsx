const VIEW_W = 180;
const VIEW_H = 100;
const PAD = 16;
const PAPER = "#EEE7D8";
const ROAD_BASE = "#C4BBA8";
const INK = "#0E0E10";
const ACCENT = "#FF6A1A";

/**
 * Real route outline for trip-list card thumbnails — draws the trip's actual
 * per-day simplified polylines (from `TripSummary.overviewGeometry`) instead
 * of the abstract `MiniRouteSvg` sketch.
 *
 * Points are projected equirectangular with a cos(lat) x-correction so the
 * shape isn't horizontally stretched at mid latitudes, then fitted into the
 * viewBox (aspect preserved, centred). Each day is its own path so
 * disconnected days don't draw an artificial connector.
 */
export function RouteOutlineSvg({
  geometry,
  className,
  accent = ACCENT,
}: {
  /** Per-day polylines of `[lng, lat]` points. */
  geometry: number[][][];
  className?: string;
  accent?: string;
}) {
  const lines = geometry.filter((line) => line.length >= 2);
  const points = lines.flat();
  if (points.length < 2) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    const lat = point[1]!;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const cosLat = Math.max(
    0.1,
    Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180),
  );
  const project = (lng: number, lat: number): [number, number] => [
    lng * cosLat,
    lat,
  ];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const [x, y] = project(point[0]!, point[1]!);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min(
    (VIEW_W - 2 * PAD) / spanX,
    (VIEW_H - 2 * PAD) / spanY,
  );
  const offX = (VIEW_W - spanX * scale) / 2;
  const offY = (VIEW_H - spanY * scale) / 2;
  const toXY = (lng: number, lat: number): [number, number] => {
    const [x, y] = project(lng, lat);
    // Flip Y: latitude increases upward, SVG y increases downward.
    return [offX + (x - minX) * scale, VIEW_H - (offY + (y - minY) * scale)];
  };

  const paths = lines.map((line) =>
    line
      .map((point, i) => {
        const [x, y] = toXY(point[0]!, point[1]!);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" "),
  );

  const firstLine = lines[0]!;
  const lastLine = lines[lines.length - 1]!;
  const start = toXY(firstLine[0]![0]!, firstLine[0]![1]!);
  const endPoint = lastLine[lastLine.length - 1]!;
  const end = toXY(endPoint[0]!, endPoint[1]!);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden="true"
    >
      <rect width={VIEW_W} height={VIEW_H} fill={PAPER} />
      {paths.map((d, i) => (
        <path
          key={`base-${i}`}
          d={d}
          fill="none"
          stroke={ROAD_BASE}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {paths.map((d, i) => (
        <path
          key={`line-${i}`}
          d={d}
          fill="none"
          stroke={accent}
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <circle cx={start[0]} cy={start[1]} r={3.4} fill={INK} />
      <circle cx={end[0]} cy={end[1]} r={3.4} fill={accent} />
    </svg>
  );
}
