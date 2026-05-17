// Shared atoms for App Tour screens — warm asphalt palette, Space Grotesk + JetBrains Mono.

const ACCENT = "#FF6A1A";
const INK = "#0E0E10";
const CREAM = "#F5EFE6";
const TARMAC = "#2B2C30";
const QCOLORS = ["#E05A3C", "#F0A03C", "#E8D66A", "#C7D36A", "#6FD38A"];

function Stamp({ children, color = INK, style }) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Heading({ children, size = 28, style }) {
  return (
    <div
      style={{
        fontFamily: "'Space Grotesk', system-ui",
        fontWeight: 800,
        fontSize: size,
        letterSpacing: -0.5,
        lineHeight: 1.05,
        color: INK,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Pill({ children, bg = INK, color = CREAM, style }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        background: bg,
        color,
        fontFamily: "'Space Grotesk', system-ui",
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function QualityBars({ q, size = 8 }) {
  return (
    <div style={{ display: "inline-flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <div
          key={n}
          style={{
            width: size,
            height: size * 1.75,
            borderRadius: 2,
            background: n <= q ? QCOLORS[q - 1] : "rgba(14,14,16,0.08)",
          }}
        />
      ))}
    </div>
  );
}

function RouteMini({
  progress = 0,
  showHazard = false,
  dark = false,
  tall = false,
}) {
  const bg = dark ? "#17181C" : "#EDE6DA";
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: tall ? 180 : 120,
        borderRadius: 18,
        overflow: "hidden",
        background: bg,
      }}
    >
      <svg
        viewBox="0 0 380 180"
        preserveAspectRatio="xMidYMid slice"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        {/* topo contours */}
        {[40, 70, 100, 130].map((y, i) => (
          <path
            key={i}
            d={`M -10 ${y} C 60 ${y - 10}, 140 ${y + 15}, 220 ${y - 5} S 340 ${y + 8}, 400 ${y - 5}`}
            stroke={dark ? "rgba(255,255,255,0.08)" : "rgba(14,14,16,0.08)"}
            strokeWidth="1"
            fill="none"
          />
        ))}
        {/* road base */}
        <path
          d="M 8 150 C 60 140, 100 120, 140 130 S 220 80, 270 70 S 340 40, 372 30"
          stroke={dark ? "#1A1B1E" : "#C4BBA8"}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
        />
        {/* quality segments */}
        <path
          d="M 8 150 C 40 145, 70 130, 100 128"
          stroke={QCOLORS[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 100 128 C 130 125, 160 110, 185 100"
          stroke={QCOLORS[3]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 185 100 C 210 90, 235 75, 260 72"
          stroke={QCOLORS[1]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 260 72 C 290 68, 320 50, 372 30"
          stroke={QCOLORS[4]}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />

        {showHazard && (
          <g transform="translate(222 86)">
            <circle r="10" fill={ACCENT} opacity="0.3">
              <animate
                attributeName="r"
                values="6;14;6"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </circle>
            <circle r="6" fill={ACCENT} />
          </g>
        )}
        {/* start + end */}
        <circle cx="8" cy="150" r="7" fill={ACCENT} />
        <circle cx="8" cy="150" r="3" fill={INK} />
        <circle cx="372" cy="30" r="7" fill={INK} />
        <circle cx="372" cy="30" r="3" fill={CREAM} />
        {/* rider */}
        {progress > 0 &&
          (() => {
            // simple linear interp along sample points
            const samples = [
              [8, 150],
              [60, 142],
              [100, 128],
              [140, 120],
              [185, 100],
              [220, 88],
              [260, 72],
              [310, 55],
              [372, 30],
            ];
            const i = Math.min(
              samples.length - 2,
              Math.floor(progress * (samples.length - 1)),
            );
            const t = progress * (samples.length - 1) - i;
            const x = samples[i][0] + (samples[i + 1][0] - samples[i][0]) * t;
            const y = samples[i][1] + (samples[i + 1][1] - samples[i][1]) * t;
            return (
              <g transform={`translate(${x} ${y})`}>
                <circle r="12" fill={ACCENT} opacity="0.25" />
                <circle
                  r="6"
                  fill={ACCENT}
                  stroke={dark ? INK : CREAM}
                  strokeWidth="1.5"
                />
              </g>
            );
          })()}
      </svg>
    </div>
  );
}

Object.assign(window, {
  ACCENT,
  INK,
  CREAM,
  TARMAC,
  QCOLORS,
  Stamp,
  Heading,
  Pill,
  QualityBars,
  RouteMini,
});
