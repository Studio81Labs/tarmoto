export interface SparklineResult {
  /** SVG path "d" attribute. Empty string when profile has < 2 points. */
  d: string;
  /** Profile minimum; NaN when profile has < 2 points. */
  min: number;
  /** Profile maximum; NaN when profile has < 2 points. */
  max: number;
}

/**
 * Builds an SVG path for a mini elevation sparkline.
 *
 * Coordinates are pixel space: x grows left-to-right, y is inverted so the
 * highest sample sits at y=0 (top of the canvas). When the profile has no
 * range (min === max) the line flattens to the vertical midpoint rather
 * than dividing by zero.
 */
export function buildSparklinePath(
  profile: number[],
  width: number,
  height: number,
): SparklineResult {
  if (profile.length < 2) {
    return { d: "", min: Number.NaN, max: Number.NaN };
  }
  const min = Math.min(...profile);
  const max = Math.max(...profile);
  const range = max - min;

  const xStep = width / (profile.length - 1);
  const points = profile.map((value, i) => {
    const x = i * xStep;
    const y =
      range === 0 ? height / 2 : height - ((value - min) / range) * height;
    return `${formatCoord(x)},${formatCoord(y)}`;
  });
  const d =
    `M${points[0]}` +
    points
      .slice(1)
      .map((p) => ` L${p}`)
      .join("");

  return { d, min, max };
}

// Strip trailing zeros so the `d` attribute reads cleanly in tests and DOM.
function formatCoord(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(3)).toString();
}
