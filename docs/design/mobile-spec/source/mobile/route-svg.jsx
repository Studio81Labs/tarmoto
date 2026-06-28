// route-svg.jsx — compact themed route graphics for cards (not the full map).

// A small quality-coloured route ribbon over faint topo, for preview cards.
function MiniRoute({
  h = 116,
  progress = 0,
  showHazard = false,
  onDark,
  seed = 0,
}) {
  const t = useT();
  const dark = onDark || t.dark;
  const topo = dark ? "rgba(243,238,230,0.09)" : "rgba(14,14,16,0.07)";
  const base = dark ? "#16171B" : "#D7CEBD";
  const bg = dark ? "#101116" : "#E7DECF";
  // segment colours along the ribbon
  const segs = [
    { d: "M 8 132 C 50 126, 86 108, 116 112", q: 5 },
    { d: "M 116 112 C 150 116, 184 98, 212 88", q: 4 },
    { d: "M 212 88 C 238 80, 262 64, 286 62", q: seed % 2 ? 2 : 3 },
    { d: "M 286 62 C 320 58, 352 40, 374 26", q: 5 },
  ];
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: h,
        borderRadius: t.rSm + 4,
        overflow: "hidden",
        background: bg,
      }}
    >
      <svg
        viewBox="0 0 382 150"
        preserveAspectRatio="xMidYMid slice"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        {[34, 62, 90, 118].map((y, i) => (
          <path
            key={i}
            d={`M -10 ${y} C 60 ${y - 12}, 150 ${y + 14}, 230 ${y - 6} S 360 ${y + 8}, 400 ${y - 4}`}
            stroke={topo}
            strokeWidth="1"
            fill="none"
          />
        ))}
        <path
          d="M 8 132 C 50 126, 86 108, 116 112 C 150 116, 184 98, 212 88 C 238 80, 262 64, 286 62 C 320 58, 352 40, 374 26"
          stroke={base}
          strokeWidth="9"
          fill="none"
          strokeLinecap="round"
        />
        {segs.map((s, i) => (
          <path
            key={i}
            d={s.d}
            stroke={QC[s.q - 1]}
            strokeWidth="6.5"
            fill="none"
            strokeLinecap="round"
          />
        ))}
        {showHazard && (
          <g transform="translate(212 88)">
            <circle r="9" fill={t.accent} opacity="0.3">
              <animate
                attributeName="r"
                values="6;13;6"
                dur="1.7s"
                repeatCount="indefinite"
              />
            </circle>
            <circle r="5.5" fill={t.accent} />
          </g>
        )}
        <circle cx="8" cy="132" r="6.5" fill={t.accent} />
        <circle cx="8" cy="132" r="2.6" fill={dark ? "#0E0E10" : "#F5EFE6"} />
        <circle cx="374" cy="26" r="6.5" fill={dark ? "#F3EEE6" : "#0E0E10"} />
        <circle cx="374" cy="26" r="2.6" fill={dark ? "#0E0E10" : "#F5EFE6"} />
        {progress > 0 &&
          (() => {
            const pts = [
              [8, 132],
              [116, 112],
              [212, 88],
              [286, 62],
              [374, 26],
            ];
            const i = Math.min(
              pts.length - 2,
              Math.floor(progress * (pts.length - 1)),
            );
            const f = progress * (pts.length - 1) - i;
            const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f;
            const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
            return (
              <g transform={`translate(${x} ${y})`}>
                <circle r="11" fill={t.accent} opacity="0.25" />
                <circle
                  r="5.5"
                  fill={t.accent}
                  stroke={dark ? "#0E0E10" : "#F5EFE6"}
                  strokeWidth="1.5"
                />
              </g>
            );
          })()}
      </svg>
    </div>
  );
}

// Elevation profile sparkline
function ElevProfile({ h = 60, color, onDark, fill = true }) {
  const t = useT();
  const c = color || t.accent;
  const pts =
    "0,48 24,40 48,44 72,28 96,32 120,16 144,22 168,8 192,18 216,12 240,26 264,20 288,34 312,30 336,42 360,38";
  return (
    <svg
      viewBox="0 0 360 56"
      preserveAspectRatio="none"
      style={{ width: "100%", height: h, display: "block" }}
    >
      {fill && (
        <polygon
          points={`0,56 ${pts} 360,56`}
          fill={c}
          opacity={onDark || t.dark ? 0.16 : 0.12}
        />
      )}
      <polyline
        points={pts}
        fill="none"
        stroke={c}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

Object.assign(window, { MiniRoute, ElevProfile });
