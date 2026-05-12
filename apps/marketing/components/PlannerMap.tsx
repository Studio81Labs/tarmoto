const peaks = [
  { x: 300, y: 230, n: "Stelvio", h: "2757m" },
  { x: 560, y: 210, n: "Gavia", h: "2621m" },
  { x: 790, y: 280, n: "Umbrail", h: "2503m" },
];

const waypoints = [
  { x: 60, y: 600, i: "A" },
  { x: 530, y: 270, i: "B" },
  { x: 990, y: 330, i: "C" },
  { x: 1150, y: 600, i: "D" },
];

// Quality-tinted route segments — palette references match --q1..--q5.
const routeSegments = [
  { d: "M 60 600 C 180 580, 260 560, 310 540", q: 5 },
  { d: "M 310 540 C 340 525, 370 495, 400 440", q: 4 },
  { d: "M 400 440 C 440 370, 480 310, 530 270", q: 5 },
  { d: "M 530 270 C 560 245, 600 215, 650 205", q: 4 },
  { d: "M 650 205 C 700 195, 760 200, 820 215", q: 5 },
  { d: "M 820 215 C 880 230, 940 270, 990 330", q: 5 },
  { d: "M 990 330 C 1050 410, 1120 500, 1150 600", q: 4 },
];

const Q_VARS = [
  "var(--q1)",
  "var(--q2)",
  "var(--q3)",
  "var(--q4)",
  "var(--q5)",
];

// 14 topo lines so each map render is consistent across sections.
const topoLines = Array.from({ length: 14 }, (_, i) => {
  const y = 30 + i * 50;
  return `M -20 ${y} C 180 ${y - 24 + (i % 3) * 6}, 360 ${y + 16}, 560 ${y - 10} S 880 ${y + 14}, 1220 ${y - 4}`;
});

export function PlannerMap() {
  return (
    <svg
      className="planner-map"
      viewBox="0 0 1200 720"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Stylized topographic map of an Alpine motorcycle loop"
    >
      <defs>
        <radialGradient id="map-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFB347" stopOpacity="0.18" />
          <stop offset="55%" stopColor="#FF9A62" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#FF6A1A" stopOpacity="0" />
        </radialGradient>
        <pattern
          id="map-dots"
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="0.6" fill="rgba(232,229,222,0.05)" />
        </pattern>
      </defs>
      <rect width="1200" height="720" fill="url(#map-dots)" />

      <g stroke="rgba(232,229,222,0.05)" strokeWidth="1" fill="none">
        {topoLines.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>

      <ellipse cx="540" cy="320" rx="280" ry="160" fill="url(#map-glow)" />

      <path
        d="M 60 620 C 240 600, 400 640, 580 600 S 900 560, 1150 620"
        stroke="rgba(110,150,200,0.30)"
        strokeWidth="1.5"
        fill="none"
      />

      <g
        stroke="rgba(232,229,222,0.10)"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      >
        <path d="M 60 600 C 200 580, 280 550, 340 510 S 440 370, 520 290 S 640 180, 760 200 S 920 240, 1000 320 S 1120 440, 1150 600" />
        <path d="M 160 580 C 260 540, 360 500, 420 470 S 540 440, 640 460 S 780 480, 900 460" />
        <path d="M 220 140 L 300 230 C 360 260, 420 300, 480 360" />
      </g>

      <g strokeWidth="5.5" fill="none" strokeLinecap="round">
        {routeSegments.map((s, i) => (
          <path key={i} d={s.d} stroke={Q_VARS[s.q - 1]} />
        ))}
      </g>

      {peaks.map((p) => (
        <g key={p.n}>
          <path
            d={`M ${p.x - 7} ${p.y + 5} L ${p.x} ${p.y - 7} L ${p.x + 7} ${p.y + 5} Z`}
            fill="none"
            stroke="rgba(232,229,222,0.45)"
            strokeWidth="1.2"
          />
          <text
            x={p.x + 12}
            y={p.y - 1}
            fill="rgba(232,229,222,0.55)"
            className="mono"
            style={{
              fontSize: "9.5px",
              fontWeight: 500,
              letterSpacing: "0.6px",
            }}
          >
            {p.n.toUpperCase()}
          </text>
          <text
            x={p.x + 12}
            y={p.y + 10}
            fill="rgba(232,229,222,0.32)"
            className="mono"
            style={{ fontSize: "8.5px" }}
          >
            {p.h}
          </text>
        </g>
      ))}

      {waypoints.map((w) => (
        <g key={w.i}>
          <circle
            cx={w.x}
            cy={w.y}
            r="13"
            fill="#0B0D10"
            stroke="#E8E5DE"
            strokeWidth="1.5"
          />
          <text
            x={w.x}
            y={w.y + 4}
            textAnchor="middle"
            fill="#E8E5DE"
            className="mono"
            style={{ fontSize: "11px", fontWeight: 600 }}
          >
            {w.i}
          </text>
        </g>
      ))}

      <g transform="translate(40 680)">
        <line
          x1="0"
          y1="0"
          x2="60"
          y2="0"
          stroke="rgba(232,229,222,0.40)"
          strokeWidth="1.5"
        />
        <line
          x1="0"
          y1="-3"
          x2="0"
          y2="3"
          stroke="rgba(232,229,222,0.40)"
          strokeWidth="1.5"
        />
        <line
          x1="60"
          y1="-3"
          x2="60"
          y2="3"
          stroke="rgba(232,229,222,0.40)"
          strokeWidth="1.5"
        />
        <text
          x="68"
          y="3.5"
          fill="rgba(232,229,222,0.40)"
          className="mono"
          style={{ fontSize: "10px", letterSpacing: "1px" }}
        >
          10 KM
        </text>
      </g>
    </svg>
  );
}
