import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * ErrorState · full-surface system-state screen (v2-error spec): a faded
 * topographic-map backdrop under a centred icon tile, `CODE • LABEL` stamp
 * row, headline, body, and action slots. One layout for every system
 * state — 404 / 403 / 500 / offline / maintenance — the `kind` picks the
 * glyph, the caller brings the (i18n'd) copy and the action buttons/links.
 *
 * Fills its nearest positioned container; pass `className` (e.g.
 * `min-h-screen`) when it IS the page.
 */
export type ErrorStateKind =
  "not-found" | "forbidden" | "server" | "offline" | "maintenance";

export interface ErrorStateProps {
  kind: ErrorStateKind;
  /** Status stamp, e.g. "404" or "OFF". Rendered mono in accent. */
  code: string;
  /** Short state label, e.g. "Not found". Rendered mono uppercase. */
  label: string;
  title: string;
  body: ReactNode;
  /** Buttons / links row under the copy. */
  actions?: ReactNode;
  /** Mono footnote under the actions (e.g. offline sync status). */
  footnote?: ReactNode;
  className?: string;
}

export function ErrorState({
  kind,
  code,
  label,
  title,
  body,
  actions,
  footnote,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "relative flex w-full flex-col overflow-hidden bg-cream text-ink",
        className,
      )}
    >
      {/* Faded topo-map backdrop + radial wash keeping the copy readable. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
      >
        <TopoBackdrop />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 40%, #F5EFE6 42%, rgba(245,239,230,0.4) 100%)",
        }}
      />

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-[60px] text-center">
        <div className="grid size-[92px] shrink-0 place-items-center rounded-[20px] border border-accent/20 bg-accent/[0.09]">
          <Glyph kind={kind} />
        </div>

        <div className="mt-6 flex items-center gap-2.5">
          <span className="font-mono text-[12px] font-bold tracking-[1px] text-accent">
            {code}
          </span>
          <span aria-hidden="true" className="size-1 rounded-full bg-ink/20" />
          <span className="font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-dim">
            {label}
          </span>
        </div>

        <h1 className="mt-3.5 max-w-[560px] text-balance text-[34px] font-extrabold leading-[1.08] tracking-[-0.8px]">
          {title}
        </h1>
        <p className="mt-4 max-w-[460px] text-pretty text-[15px] leading-[1.6] text-fg-dim">
          {body}
        </p>

        {actions && (
          <div className="mt-[30px] flex flex-wrap justify-center gap-2.5">
            {actions}
          </div>
        )}
        {footnote && (
          <div className="mt-[18px] font-mono text-[10px] font-bold uppercase tracking-[1.6px] text-fg-mute">
            {footnote}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Glyphs · 32×32, drawn to read at 50 px inside the icon tile ── */

function Glyph({ kind }: { kind: ErrorStateKind }) {
  const common = {
    width: 50,
    height: 50,
    viewBox: "0 0 32 32",
    fill: "none",
    "aria-hidden": true as const,
  };
  switch (kind) {
    case "not-found":
      // A route that trails off short of its pin.
      return (
        <svg {...common}>
          <path
            d="M3 28C8 25 10 20 14 18"
            stroke="#0E0E10"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="0.2 3.4"
          />
          <path
            d="M22 21s5-3.9 5-8.2a5 5 0 0 0-10 0C17 17.1 22 21 22 21Z"
            stroke="#FF6A1A"
            strokeWidth={2.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx={22} cy={12.8} r={1.9} fill="#FF6A1A" />
        </svg>
      );
    case "forbidden":
      // Padlock — accent shackle over an ink body.
      return (
        <svg {...common}>
          <path
            d="M11.5 14v-3.2a4.5 4.5 0 0 1 9 0V14"
            stroke="#FF6A1A"
            strokeWidth={2.1}
            strokeLinecap="round"
          />
          <rect
            x={9}
            y={14}
            width={14}
            height={11.5}
            rx={2.5}
            stroke="#0E0E10"
            strokeWidth={1.9}
          />
          <circle cx={16} cy={18.6} r={1.7} fill="#0E0E10" />
          <path
            d="M16 20v2.6"
            stroke="#0E0E10"
            strokeWidth={1.9}
            strokeLinecap="round"
          />
        </svg>
      );
    case "server":
      // Warning bolt in a gauge ring.
      return (
        <svg {...common}>
          <circle cx={16} cy={16} r={11} stroke="#0E0E10" strokeWidth={1.9} />
          <path
            d="M17.6 9.5l-5 7.6h3.6l-1.8 5.4 5.4-7.6h-3.6l1.4-5.4Z"
            fill="#FF6A1A"
            stroke="#FF6A1A"
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
        </svg>
      );
    case "offline":
      // Wifi arcs with an accent slash.
      return (
        <svg {...common}>
          <path
            d="M8.5 15.5a11 11 0 0 1 15 0"
            stroke="#0E0E10"
            strokeWidth={1.9}
            strokeLinecap="round"
          />
          <path
            d="M12.2 19.4a6 6 0 0 1 7.6 0"
            stroke="#0E0E10"
            strokeWidth={1.9}
            strokeLinecap="round"
          />
          <circle cx={16} cy={23.4} r={1.8} fill="#0E0E10" />
          <path
            d="M7 8.5 25 25"
            stroke="#FF6A1A"
            strokeWidth={2.1}
            strokeLinecap="round"
          />
        </svg>
      );
    case "maintenance":
      // Traffic cone with accent stripes.
      return (
        <svg {...common}>
          <path
            d="M13.4 7.5h5.2L23 24.5H9L13.4 7.5Z"
            stroke="#0E0E10"
            strokeWidth={1.9}
            strokeLinejoin="round"
          />
          <path d="M12.1 12.6h7.8" stroke="#FF6A1A" strokeWidth={2.2} />
          <path d="M10.9 17.6h10.2" stroke="#FF6A1A" strokeWidth={2.2} />
          <path
            d="M6.5 24.5h19"
            stroke="#0E0E10"
            strokeWidth={1.9}
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/* ── Topographic backdrop · faint contours, two routes, towns, scale ── */

const CONTOURS = [
  40, 95, 150, 205, 260, 315, 370, 425, 480, 535, 590, 645, 700, 755,
] as const;

const TOWNS = [
  { x: 180, y: 640, name: "Bormio" },
  { x: 720, y: 660, name: "Tirano" },
  { x: 960, y: 420, name: "Livigno" },
  { x: 240, y: 180, name: "Trafoi" },
  { x: 1060, y: 720, name: "Sondrio" },
] as const;

function contourPath(y: number, index: number): string {
  // Every contour shares the wave shape; the first crest cycles through
  // three depths, matching the spec's hand-drawn irregularity.
  const lift = [28, 20, 12][index % 3] ?? 20;
  return `M -20 ${y} C 150 ${y - lift}, 320 ${y + 22}, 520 ${y - 12} S 820 ${y + 18}, 1050 ${y - 6} S 1220 ${y + 6}, 1240 ${y}`;
}

function TopoBackdrop() {
  return (
    <svg
      viewBox="0 0 1200 820"
      preserveAspectRatio="xMidYMid slice"
      className="block h-full w-full bg-paper-2"
      aria-hidden="true"
    >
      <defs>
        <filter id="tm-error-paper-noise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            seed="3"
          />
          <feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.08  0 0 0 0 0.05  0 0 0 0.06 0" />
        </filter>
      </defs>
      <rect
        width="1200"
        height="820"
        filter="url(#tm-error-paper-noise)"
        opacity="0.7"
      />
      {/* contour lines */}
      <g stroke="rgba(14,14,16,0.08)" strokeWidth="1" fill="none">
        {CONTOURS.map((y, index) => (
          <path key={y} d={contourPath(y, index)} />
        ))}
      </g>
      {/* ridge accents */}
      <g stroke="rgba(14,14,16,0.14)" strokeWidth="1.3" fill="none">
        <path d="M 160 280 C 260 240, 360 300, 480 260 S 700 220, 860 280" />
        <path d="M 280 480 C 380 440, 500 510, 640 470 S 880 430, 980 490" />
      </g>
      {/* rivers */}
      <g
        stroke="rgba(80,120,160,0.55)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      >
        <path d="M 80 700 C 220 680, 340 720, 500 680 S 800 660, 1100 700" />
        <path d="M 620 780 C 680 720, 720 660, 700 560" />
      </g>
      {/* roads */}
      <g
        stroke="#C4BBA8"
        strokeWidth="4.5"
        fill="none"
        strokeLinecap="round"
        opacity="0.85"
      >
        <path d="M 80 660 C 200 640, 280 620, 340 580 S 440 440, 520 350 S 620 240, 720 240 S 880 280, 960 360 S 1080 480, 1100 620" />
        <path d="M 180 640 C 280 620, 360 580, 420 540 S 540 500, 640 520 S 780 540, 900 520" />
        <path d="M 240 180 L 310 255 C 360 280, 420 320, 480 380" />
        <path d="M 720 660 C 800 620, 880 560, 960 420" />
        <path d="M 120 300 C 200 360, 300 380, 400 340" />
        <path d="M 600 100 C 700 160, 800 180, 900 140" />
      </g>
      {/* towns */}
      {TOWNS.map((town) => (
        <g key={town.name}>
          <circle cx={town.x} cy={town.y} r="4.5" fill="#0E0E10" />
          <circle
            cx={town.x}
            cy={town.y}
            r="9"
            fill="none"
            stroke="#0E0E10"
            strokeOpacity="0.3"
          />
          <text
            x={town.x + 14}
            y={town.y + 4}
            fill="#0E0E10"
            style={{
              fontFamily: '"Space Grotesk", system-ui',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {town.name}
          </text>
        </g>
      ))}
      {/* scale bar */}
      <g transform="translate(40 780)" stroke="rgba(14,14,16,0.62)">
        <line x1="0" y1="0" x2="60" y2="0" strokeWidth="2" />
        <line x1="0" y1="-4" x2="0" y2="4" strokeWidth="2" />
        <line x1="60" y1="-4" x2="60" y2="4" strokeWidth="2" />
        <text
          x="68"
          y="4"
          fill="rgba(14,14,16,0.62)"
          stroke="none"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            letterSpacing: 1,
          }}
        >
          10 KM
        </text>
      </g>
      {/* compass */}
      <g transform="translate(1130 60)">
        <circle
          r="18"
          fill="none"
          stroke="rgba(14,14,16,0.62)"
          strokeWidth="1"
        />
        <path d="M 0 -14 L -5 4 L 0 0 L 5 4 Z" fill="rgba(14,14,16,0.62)" />
        <text
          y="-22"
          textAnchor="middle"
          fill="rgba(14,14,16,0.62)"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          N
        </text>
      </g>
    </svg>
  );
}
