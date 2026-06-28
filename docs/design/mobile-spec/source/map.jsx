// Stylized Alps map — hand-drawn SVG. Non-real geography, but map-feeling.
// The "road" is a single path shared across layouts; other elements (quality, hazards,
// topo, waypoints) animate along it based on the rider's progress (0..1 along the path).

// Master road path — drawn once, referenced everywhere
const ROAD_D =
  "M -40 620 C 60 600, 130 560, 180 520 S 280 440, 340 460 S 440 540, 490 510 S 560 400, 620 380 S 740 400, 790 350 S 840 220, 900 200 S 1020 240, 1080 180";

// Quality-tier color mapping (green → red, muted warm)
const QUALITY_COLORS = {
  5: "#6FD38A", // excellent
  4: "#C7D36A", // good
  3: "#E8D66A", // fair
  2: "#F0A03C", // poor
  1: "#E05A3C", // very poor
};

// Road quality segments — distance along path in %, quality 1-5
const ROAD_SEGMENTS = [
  { start: 0, end: 15, q: 5 },
  { start: 15, end: 28, q: 4 },
  { start: 28, end: 38, q: 5 },
  { start: 38, end: 48, q: 3 },
  { start: 48, end: 58, q: 2 }, // poor section — this is where the hazard is
  { start: 58, end: 68, q: 4 },
  { start: 68, end: 82, q: 5 },
  { start: 82, end: 100, q: 4 },
];

// Hazards along the road (percentage along path)
const HAZARDS = [
  { at: 54, type: "pothole", label: "Pothole", severity: "high" },
  { at: 72, type: "gravel", label: "Gravel", severity: "med" },
  { at: 88, type: "wet", label: "Wet road", severity: "low" },
];

// Waypoints / POIs
const WAYPOINTS = [
  { at: 8, name: "Innsbruck", sub: "Start", kind: "start" },
  { at: 42, name: "Brenner Pass", sub: "1,370 m", kind: "pass" },
  { at: 65, name: "Passo dello Stelvio", sub: "2,758 m", kind: "pass" },
  { at: 95, name: "Bormio", sub: "Finish", kind: "end" },
];

// Build a sampled polyline from the SVG path so we can locate points on it
function samplePath(d, samples = 200) {
  if (typeof document === "undefined") return [];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  const total = path.getTotalLength();
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const p = path.getPointAtLength((i / samples) * total);
    pts.push({ x: p.x, y: p.y, t: i / samples });
  }
  return pts;
}

// Memoize one sampling
let _cachedPts = null;
function getPathPoints() {
  if (!_cachedPts) _cachedPts = samplePath(ROAD_D, 300);
  return _cachedPts;
}

function pointAt(pct) {
  const pts = getPathPoints();
  if (!pts.length) return { x: 0, y: 0 };
  const i = Math.min(
    pts.length - 1,
    Math.max(0, Math.floor((pct / 100) * pts.length)),
  );
  return pts[i];
}

// Build the per-segment overlay paths (colored strokes over the master road)
function SegmentPath({ start, end, q, mapStyle }) {
  if (mapStyle === "topo") return null; // topo hides quality
  const pts = getPathPoints();
  if (!pts.length) return null;
  const i0 = Math.floor((start / 100) * pts.length);
  const i1 = Math.ceil((end / 100) * pts.length);
  const slice = pts.slice(i0, i1 + 1);
  if (slice.length < 2) return null;
  const d =
    "M " + slice.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  const color = QUALITY_COLORS[q];
  return (
    <path
      d={d}
      stroke={color}
      strokeWidth={mapStyle === "hybrid" ? 7 : 9}
      strokeLinecap="round"
      fill="none"
      style={{
        filter:
          mapStyle === "heatmap" ? `drop-shadow(0 0 6px ${color}aa)` : "none",
      }}
    />
  );
}

// Topographic contour lines for background texture
function TopoContours({ dark }) {
  const stroke = dark ? "rgba(255,255,255,0.06)" : "rgba(14,14,16,0.08)";
  const paths = [
    "M -20 200 C 80 220, 180 240, 280 210 S 460 160, 560 190 S 760 240, 880 210 S 1020 170, 1100 200",
    "M -20 260 C 80 280, 200 300, 300 270 S 480 220, 580 250 S 780 300, 900 270 S 1040 230, 1100 260",
    "M -20 340 C 100 360, 220 380, 320 340 S 500 290, 600 320 S 800 370, 920 340 S 1060 300, 1100 330",
    "M -20 420 C 120 440, 240 460, 340 420 S 520 370, 620 400 S 820 450, 940 420 S 1080 380, 1100 410",
    "M -20 500 C 140 520, 260 540, 360 500 S 540 450, 640 480 S 840 530, 960 500 S 1100 460, 1120 490",
    "M -20 580 C 160 600, 280 620, 380 580 S 560 530, 660 560 S 860 610, 980 580 S 1120 540, 1140 570",
    "M -20 660 C 180 680, 300 700, 400 660 S 580 610, 680 640 S 880 690, 1000 660 S 1140 620, 1160 650",
  ];
  return (
    <g opacity="0.9">
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth={0.8 + (i % 3) * 0.4}
          fill="none"
        />
      ))}
    </g>
  );
}

// Mountain ranges
function Mountains({ dark }) {
  const fill = dark ? "rgba(255,255,255,0.03)" : "rgba(14,14,16,0.06)";
  const stroke = dark ? "rgba(255,255,255,0.1)" : "rgba(14,14,16,0.15)";
  return (
    <g>
      <path
        d="M 80 330 L 170 210 L 240 280 L 310 190 L 380 260 L 450 220 L 500 280 L 500 360 L 80 360 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.6"
      />
      <path
        d="M 560 290 L 640 180 L 710 240 L 790 150 L 870 220 L 940 170 L 1020 230 L 1080 180 L 1080 320 L 560 320 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.6"
      />
    </g>
  );
}

// Little helpers for waypoint markers
function WaypointMarker({ wp, accent, dark, mapStyle }) {
  const pos = pointAt(wp.at);
  const isStartEnd = wp.kind === "start" || wp.kind === "end";
  const c = isStartEnd ? accent : dark ? "#F5EFE6" : "#0E0E10";
  return (
    <g transform={`translate(${pos.x} ${pos.y})`}>
      {isStartEnd ? (
        <>
          <circle r="14" fill={c} />
          <circle r="6" fill={dark ? "#0E0E10" : "#F5EFE6"} />
        </>
      ) : (
        <>
          {/* pass summit marker — triangle */}
          <polygon
            points="-10,8 10,8 0,-10"
            fill={dark ? "#1A1A1E" : "#F5EFE6"}
            stroke={c}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </>
      )}
    </g>
  );
}

// Hazard marker — pulses
function HazardMarker({ h, accent }) {
  const pos = pointAt(h.at);
  return (
    <g transform={`translate(${pos.x} ${pos.y})`}>
      <circle r="18" fill={accent} opacity="0.2">
        <animate
          attributeName="r"
          values="10;22;10"
          dur="1.8s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0.5;0;0.5"
          dur="1.8s"
          repeatCount="indefinite"
        />
      </circle>
      <circle r="10" fill={accent} />
      <text
        y="3.5"
        textAnchor="middle"
        fontSize="12"
        fontWeight="800"
        fill="#0E0E10"
        fontFamily="'Space Grotesk', system-ui"
      >
        !
      </text>
    </g>
  );
}

// Rider position — arrow / chevron, rotated along path direction
function RiderMarker({ pct, accent, dark }) {
  const pts = getPathPoints();
  if (!pts.length) return null;
  const i = Math.min(
    pts.length - 2,
    Math.max(0, Math.floor((pct / 100) * pts.length)),
  );
  const p0 = pts[i];
  const p1 = pts[i + 1];
  const angle = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
  return (
    <g transform={`translate(${p0.x} ${p0.y}) rotate(${angle})`}>
      <circle r="22" fill={accent} opacity="0.15" />
      <circle r="16" fill={accent} opacity="0.25" />
      <g transform="rotate(-90)">
        <path
          d="M 0 -10 L 8 8 L 0 3 L -8 8 Z"
          fill={accent}
          stroke={dark ? "#0E0E10" : "#F5EFE6"}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </g>
    </g>
  );
}

// The actual Map view
function TarmotoMap({
  progress = 40, // 0..100 along the route
  theme = "dark", // 'light' | 'dark' | 'oled'
  mapStyle = "heatmap", // 'heatmap' | 'topo' | 'hybrid'
  qualityMin = 1, // 1..5; hide segments worse than this
  accent = "#FF6A1A",
  width = 402,
  height = 600,
  showLabels = true,
}) {
  const dark = theme !== "light";
  const bg =
    theme === "oled" ? "#000" : theme === "dark" ? "#17181C" : "#EDE6DA";
  const roadBase = dark ? "#2B2C30" : "#D4CBBA";
  const labelColor = dark ? "rgba(245,239,230,0.85)" : "rgba(14,14,16,0.85)";
  const labelSub = dark ? "rgba(245,239,230,0.5)" : "rgba(14,14,16,0.55)";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: bg,
        overflow: "hidden",
      }}
    >
      {/* grain */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.06,
          pointerEvents: "none",
          backgroundImage:
            "radial-gradient(circle at 20% 30%, rgba(255,106,26,0.3) 0, transparent 30%)," +
            "radial-gradient(circle at 80% 70%, rgba(255,106,26,0.2) 0, transparent 40%)",
        }}
      />

      <svg
        viewBox="0 0 1040 720"
        preserveAspectRatio="xMidYMid slice"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        <defs>
          <pattern
            id="grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke={dark ? "rgba(255,255,255,0.04)" : "rgba(14,14,16,0.05)"}
              strokeWidth="0.5"
            />
          </pattern>
        </defs>

        {mapStyle !== "heatmap" && (
          <rect width="1040" height="720" fill="url(#grid)" />
        )}

        {(mapStyle === "topo" || mapStyle === "hybrid") && (
          <TopoContours dark={dark} />
        )}
        <Mountains dark={dark} />

        {/* Road base */}
        <path
          d={ROAD_D}
          stroke={dark ? "#1A1B1E" : "#C4BBA8"}
          strokeWidth="13"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d={ROAD_D}
          stroke={roadBase}
          strokeWidth="11"
          fill="none"
          strokeLinecap="round"
        />

        {/* Quality overlay */}
        {mapStyle !== "topo" &&
          ROAD_SEGMENTS.filter((s) => s.q >= qualityMin).map((s, i) => (
            <SegmentPath key={i} {...s} mapStyle={mapStyle} />
          ))}

        {/* Dashed centerline for style */}
        <path
          d={ROAD_D}
          stroke={dark ? "rgba(245,239,230,0.25)" : "rgba(14,14,16,0.3)"}
          strokeWidth="0.8"
          fill="none"
          strokeDasharray="4 8"
        />

        {/* Waypoints */}
        {WAYPOINTS.map((wp, i) => (
          <WaypointMarker
            key={i}
            wp={wp}
            accent={accent}
            dark={dark}
            mapStyle={mapStyle}
          />
        ))}

        {/* Hazards */}
        {HAZARDS.map((h, i) => (
          <HazardMarker key={i} h={h} accent={accent} />
        ))}

        {/* Rider */}
        <RiderMarker pct={progress} accent={accent} dark={dark} />

        {/* Waypoint labels */}
        {showLabels &&
          WAYPOINTS.map((wp, i) => {
            const pos = pointAt(wp.at);
            return (
              <g key={i} transform={`translate(${pos.x + 18} ${pos.y - 8})`}>
                <text
                  fontSize="13"
                  fontWeight="700"
                  fill={labelColor}
                  fontFamily="'Space Grotesk', system-ui"
                >
                  {wp.name}
                </text>
                <text
                  y="14"
                  fontSize="10"
                  fontWeight="500"
                  fill={labelSub}
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {wp.sub}
                </text>
              </g>
            );
          })}
      </svg>
    </div>
  );
}

Object.assign(window, {
  TarmotoMap,
  ROAD_D,
  ROAD_SEGMENTS,
  HAZARDS,
  WAYPOINTS,
  QUALITY_COLORS,
  pointAt,
  samplePath,
  getPathPoints,
});
