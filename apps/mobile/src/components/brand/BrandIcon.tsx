import React from "react";
import Svg, { Circle, Path, Rect, type SvgProps } from "react-native-svg";

/**
 * Hand-rolled stroke icon set for the Tarmoto brand (mobile).
 *
 * Ported from `mobile/tokens.jsx` (`Icon`) in the design handoff
 * (`docs/design/mobile-spec/source/`). Brand rule #3: no icon font — these
 * are geometric SVG glyphs on a 24×24 grid. The legacy app uses
 * `@react-native-vector-icons/material-design-icons`; brand surfaces use
 * this set so the icon language matches the spec exactly.
 */

export type BrandIconName =
  | "home"
  | "roads"
  | "route"
  | "user"
  | "gauge"
  | "alert"
  | "bolt"
  | "plus"
  | "flag"
  | "mountain"
  | "share"
  | "left"
  | "right"
  | "close"
  | "layers"
  | "filter"
  | "pin"
  | "nav"
  | "check"
  | "clock"
  | "trend"
  | "speed"
  | "settings"
  | "grid"
  | "phone"
  | "heart"
  | "sun"
  | "moon";

interface BrandIconProps {
  name: BrandIconName;
  size?: number;
  color?: string;
  /** Stroke width. */
  sw?: number;
  /** Fill for the whole glyph (most icons are stroked, not filled). */
  fill?: string;
  style?: SvgProps["style"];
}

/**
 * Render one brand glyph. Each entry is a function of the shared stroke
 * props so callers can recolour / re-weight a glyph without duplicating
 * path data. Unknown names render an empty (but valid) SVG rather than
 * throwing, matching the prototype's lookup-by-name behaviour.
 */
export default function BrandIcon({
  name,
  size = 22,
  color = "currentColor",
  sw = 1.8,
  fill = "none",
  style,
}: BrandIconProps) {
  const p = {
    stroke: color,
    strokeWidth: sw,
    fill,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const glyphs: Record<BrandIconName, React.ReactNode> = {
    home: (
      <>
        <Path d="M3 11.5 12 4l9 7.5" {...p} />
        <Path d="M6 10v9h12v-9" {...p} />
      </>
    ),
    roads: (
      <>
        <Circle cx={12} cy={12} r={8.4} {...p} />
        <Path
          d="M3.6 12H20.4M12 3.6c2.6 2.4 2.6 14.4 0 16.8M12 3.6c-2.6 2.4-2.6 14.4 0 16.8"
          {...p}
        />
      </>
    ),
    route: (
      <>
        <Circle cx={6} cy={18} r={2.4} {...p} />
        <Circle cx={18} cy={6} r={2.4} {...p} />
        <Path
          d="M8.4 18H14a3.5 3.5 0 0 0 0-7H10a3.5 3.5 0 0 1 0-7h5.6"
          {...p}
        />
      </>
    ),
    user: (
      <>
        <Circle cx={12} cy={8} r={3.6} {...p} />
        <Path d="M5 20c0-4 3.2-6 7-6s7 2 7 6" {...p} />
      </>
    ),
    gauge: (
      <>
        <Path d="M4.5 18a9 9 0 1 1 15 0" {...p} />
        <Path d="M12 14l4-4" {...p} />
        <Circle cx={12} cy={14} r={1.3} fill={color} stroke="none" />
      </>
    ),
    alert: (
      <>
        <Path d="M12 3 2.5 20h19L12 3Z" {...p} />
        <Path d="M12 10v4.5" {...p} />
        <Circle
          cx={12}
          cy={17.4}
          r={0.4}
          fill={color}
          stroke={color}
          strokeWidth={1.2}
        />
      </>
    ),
    bolt: <Path d="M13 3 5 13h5l-1 8 8-11h-5l1-7Z" {...p} />,
    plus: <Path d="M12 5v14M5 12h14" {...p} />,
    flag: <Path d="M6 21V4M6 4h11l-2.5 4L17 12H6" {...p} />,
    mountain: <Path d="M3 19 9.5 7l3.5 6 2-3 5 9H3Z" {...p} />,
    share: (
      <>
        <Circle cx={6} cy={12} r={2.4} {...p} />
        <Circle cx={17} cy={6} r={2.4} {...p} />
        <Circle cx={17} cy={18} r={2.4} {...p} />
        <Path d="M8.2 10.8 14.8 7.2M8.2 13.2l6.6 3.6" {...p} />
      </>
    ),
    left: <Path d="M15 5l-7 7 7 7" {...p} />,
    right: <Path d="M9 5l7 7-7 7" {...p} />,
    close: <Path d="M6 6l12 12M18 6 6 18" {...p} />,
    layers: (
      <>
        <Path d="M12 3 3 8l9 5 9-5-9-5Z" {...p} />
        <Path d="M3 13l9 5 9-5M3 18l9 5 9-5" {...p} opacity={0.5} />
      </>
    ),
    filter: <Path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" {...p} />,
    pin: (
      <>
        <Path d="M12 21s7-5.4 7-11A7 7 0 0 0 5 10c0 5.6 7 11 7 11Z" {...p} />
        <Circle cx={12} cy={10} r={2.4} {...p} />
      </>
    ),
    nav: <Path d="M12 3 4 21l8-4 8 4L12 3Z" {...p} />,
    check: <Path d="M5 12.5 10 17l9-10" {...p} />,
    clock: (
      <>
        <Circle cx={12} cy={12} r={8.4} {...p} />
        <Path d="M12 7.5V12l3 2" {...p} />
      </>
    ),
    trend: (
      <>
        <Path d="M4 16l5-5 3 3 8-8" {...p} />
        <Path d="M16 6h5v5" {...p} />
      </>
    ),
    speed: (
      <>
        <Path d="M12 4a8 8 0 0 1 8 8M12 4a8 8 0 0 0-8 8" {...p} />
        <Path d="M4 12h2M18 12h2M12 12l3.5-2.5" {...p} />
        <Circle cx={12} cy={12} r={1.2} fill={color} stroke="none" />
      </>
    ),
    settings: (
      <>
        <Circle cx={12} cy={12} r={3} {...p} />
        <Path
          d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
          {...p}
        />
      </>
    ),
    grid: (
      <>
        <Rect x={4} y={4} width={6.5} height={6.5} rx={1.5} {...p} />
        <Rect x={13.5} y={4} width={6.5} height={6.5} rx={1.5} {...p} />
        <Rect x={4} y={13.5} width={6.5} height={6.5} rx={1.5} {...p} />
        <Rect x={13.5} y={13.5} width={6.5} height={6.5} rx={1.5} {...p} />
      </>
    ),
    phone: <Rect x={6.5} y={2.5} width={11} height={19} rx={2.5} {...p} />,
    heart: (
      <Path
        d="M12 20s-7-4.5-7-9.5A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 7 2.5C19 15.5 12 20 12 20Z"
        {...p}
      />
    ),
    sun: (
      <>
        <Circle cx={12} cy={12} r={4} {...p} />
        <Path
          d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
          {...p}
        />
      </>
    ),
    moon: <Path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" {...p} />,
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style}>
      {glyphs[name]}
    </Svg>
  );
}
