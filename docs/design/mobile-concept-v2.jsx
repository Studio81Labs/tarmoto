import { useCallback, useEffect, useRef, useState } from "react";

const C = {
  bg: "#05070B",
  bg2: "#081018",
  frame: "#0D1219",
  panel: "#101722",
  panel2: "#141D28",
  line: "rgba(255,255,255,0.08)",
  line2: "rgba(255,255,255,0.12)",
  text: "#F4F7FB",
  sub: "#97A4B6",
  dim: "#6B768A",
  cyan: "#62E6E0",
  cyanSoft: "rgba(98,230,224,0.14)",
  cyanLine: "rgba(98,230,224,0.28)",
  good: "#47D38A",
  fair: "#F0C05A",
  poor: "#F79361",
  danger: "#FF6B6B",
  road: "#DCE4EE",
};

const SCENES = [
  { id: "overview", label: "Overview", note: "Ride ready" },
  { id: "map", label: "Map intelligence", note: "Road quality" },
  { id: "ride", label: "Ride mode", note: "Cockpit" },
  { id: "review", label: "Review", note: "After ride" },
];

const MODE_PRESETS = {
  commute: {
    title: "Commute shortcut",
    subtitle: "Home -> office",
    metric: "14.2 km",
    eta: "21 min",
    score: 4.4,
    confidence: 92,
    surface: "Mostly asphalt",
    note: "Fastest clean route with one caution segment.",
  },
  weekend: {
    title: "Weekend loop",
    subtitle: "North ridge and back",
    metric: "118 km",
    eta: "2h 42m",
    score: 4.8,
    confidence: 96,
    surface: "High confidence asphalt",
    note: "Best surface mix for a fun ride.",
  },
  trip: {
    title: "Trip plan",
    subtitle: "3-day border route",
    metric: "412 km",
    eta: "3 days",
    score: 4.6,
    confidence: 88,
    surface: "Filtered above 4.0",
    note: "Built around roads worth riding, not just roads that connect.",
  },
};

const MODE_KEYS = Object.keys(MODE_PRESETS);

const ROAD_LIST = {
  commute: [
    {
      name: "Ring connector",
      score: 4.8,
      confidence: 97,
      surface: "Fresh asphalt",
      delta: "+0.4",
    },
    {
      name: "Depot cut",
      score: 4.0,
      confidence: 83,
      surface: "Patchy tarmac",
      delta: "-0.2",
    },
    {
      name: "River bend",
      score: 2.9,
      confidence: 68,
      surface: "Loose gravel edge",
      delta: "-1.1",
    },
  ],
  weekend: [
    {
      name: "North ridge",
      score: 4.9,
      confidence: 98,
      surface: "Glass-smooth asphalt",
      delta: "+0.6",
    },
    {
      name: "Quarry link",
      score: 3.2,
      confidence: 74,
      surface: "Mixed surface",
      delta: "-0.8",
    },
    {
      name: "Forest pass",
      score: 4.5,
      confidence: 90,
      surface: "Clean sweep",
      delta: "+0.2",
    },
  ],
  trip: [
    {
      name: "Day 1 mountain run",
      score: 4.7,
      confidence: 95,
      surface: "Strong asphalt network",
      delta: "+0.3",
    },
    {
      name: "Day 2 valley connector",
      score: 4.2,
      confidence: 86,
      surface: "Mostly clean",
      delta: "-0.1",
    },
    {
      name: "Day 3 return leg",
      score: 4.6,
      confidence: 91,
      surface: "Filtered route",
      delta: "+0.4",
    },
  ],
};

const MAP_SEGMENTS = [
  {
    id: "a",
    name: "City link",
    score: 4.8,
    confidence: 96,
    surface: "Fresh asphalt",
    note: "Strong sample density.",
    d: "M 34 402 C 68 370, 100 346, 130 320 S 194 266, 222 238",
    labelX: 120,
    labelY: 338,
  },
  {
    id: "b",
    name: "North ridge",
    score: 4.5,
    confidence: 91,
    surface: "Clean surface",
    note: "Best segment in this loop.",
    d: "M 222 238 C 246 214, 270 196, 298 172 S 342 128, 364 106",
    labelX: 300,
    labelY: 180,
  },
  {
    id: "c",
    name: "Quarry link",
    score: 3.1,
    confidence: 73,
    surface: "Loose gravel edge",
    note: "Use caution on the outside line.",
    d: "M 124 360 C 154 338, 182 320, 214 304 S 278 274, 316 248",
    labelX: 215,
    labelY: 304,
  },
  {
    id: "d",
    name: "River cut",
    score: 4.1,
    confidence: 84,
    surface: "Patchy tarmac",
    note: "Still rideable, but not the fastest.",
    d: "M 168 450 C 188 412, 204 378, 222 342 S 248 280, 276 224",
    labelX: 250,
    labelY: 352,
  },
];

const REVIEW_BANDS = [
  { label: "Excellent", value: 42, color: C.good },
  { label: "Good", value: 30, color: "#84CC16" },
  { label: "Fair", value: 16, color: C.fair },
  { label: "Poor", value: 8, color: C.poor },
  { label: "Very poor", value: 4, color: C.danger },
];

const REPORT_TYPES = [
  { id: "gravel", label: "Gravel", tone: C.fair },
  { id: "pothole", label: "Pothole", tone: C.poor },
  { id: "oil", label: "Oil", tone: C.danger },
  { id: "roadworks", label: "Roadworks", tone: C.cyan },
];

function rgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function qualityColor(score) {
  if (score >= 4.5) return C.good;
  if (score >= 3.5) return "#A8D21D";
  if (score >= 2.5) return C.fair;
  if (score >= 1.5) return C.poor;
  return C.danger;
}

function qualityLabel(score) {
  if (score >= 4.5) return "Excellent";
  if (score >= 3.5) return "Good";
  if (score >= 2.5) return "Fair";
  if (score >= 1.5) return "Poor";
  return "Very poor";
}

function SceneTab({ active, label, note, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? rgba(C.cyan, 0.5) : C.line}`,
        background: active ? rgba(C.cyan, 0.12) : C.panel,
        color: active ? C.text : C.sub,
        borderRadius: 18,
        padding: "12px 14px",
        textAlign: "left",
        cursor: "pointer",
        transition: "transform 160ms ease, border-color 160ms ease, background 160ms ease",
        boxShadow: active ? `0 0 0 1px ${rgba(C.cyan, 0.18)} inset` : "none",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: active ? C.cyan : C.sub, fontWeight: 600 }}>
        {note}
      </div>
    </button>
  );
}

function QualityGauge({ score, confidence, compact = false }) {
  const color = qualityColor(score);
  const size = compact ? 84 : 108;
  const ring = `${Math.round((score / 5) * 100)}%`;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: `conic-gradient(${color} 0 ${ring}, ${rgba("#FFFFFF", 0.08)} ${ring} 100%)`,
          padding: compact ? 7 : 9,
          boxShadow: `0 0 0 1px ${rgba(color, 0.18)} inset`,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            background: `radial-gradient(circle at 30% 20%, ${rgba(color, 0.18)}, ${C.panel} 62%)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: compact ? 25 : 30, lineHeight: 1, fontWeight: 900, color: C.text }}>
            {score.toFixed(1)}
          </div>
          <div style={{ fontSize: 9, letterSpacing: "0.08em", color: C.sub, fontWeight: 700, marginTop: 4 }}>
            ROAD SCORE
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: -2,
          bottom: -2,
          borderRadius: 999,
          padding: "4px 8px",
          background: C.bg,
          border: `1px solid ${rgba(color, 0.25)}`,
          color: color,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.04em",
        }}
      >
        {confidence}%
      </div>
    </div>
  );
}

function MetricCard({ label, value, hint, accent = C.cyan }) {
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        padding: 14,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: "0.1em", color: C.sub, fontWeight: 800, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 19, fontWeight: 900, color: C.text, lineHeight: 1.05 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: accent, marginTop: 6, fontWeight: 700 }}>
        {hint}
      </div>
    </div>
  );
}

function RoadRibbon({ segments, selectedId, onSelect }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {segments.map((segment) => {
        const selected = selectedId === segment.id;
        const color = qualityColor(segment.score);
        return (
          <button
            key={segment.id}
            type="button"
            onClick={() => onSelect(segment.id)}
            style={{
              border: `1px solid ${selected ? rgba(color, 0.48) : C.line}`,
              background: selected ? rgba(color, 0.14) : C.panel,
              borderRadius: 14,
              padding: "10px 12px",
              minWidth: 108,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 10, color: selected ? color : C.sub, fontWeight: 800, marginBottom: 4 }}>
              {segment.name}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ color: C.text, fontWeight: 900, fontSize: 16 }}>{segment.score.toFixed(1)}</span>
              <span style={{ color: C.dim, fontSize: 9, fontWeight: 700 }}>{segment.surface}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MapCanvas({ selectedSegmentId, emphasis = "quality" }) {
  const selected = MAP_SEGMENTS.find((segment) => segment.id === selectedSegmentId) || MAP_SEGMENTS[0];

  return (
    <svg viewBox="0 0 390 540" width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
      <defs>
        <linearGradient id="mapBg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#07101A" />
          <stop offset="100%" stopColor="#05070B" />
        </linearGradient>
        <linearGradient id="routeGlow" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor={C.cyan} stopOpacity="0.96" />
          <stop offset="48%" stopColor={C.good} stopOpacity="0.92" />
          <stop offset="78%" stopColor={C.fair} stopOpacity="0.92" />
          <stop offset="100%" stopColor={C.poor} stopOpacity="0.92" />
        </linearGradient>
        <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect width="390" height="540" fill="url(#mapBg)" />
      <rect width="390" height="540" fill="url(#mapBg)" opacity="0.8" />

      <g opacity="0.18">
        {Array.from({ length: 7 }).map((_, index) => (
          <path
            key={`contour-${index}`}
            d={`M -40 ${72 + index * 60} C 40 ${28 + index * 60}, 92 ${96 + index * 60}, 160 ${72 + index * 60} S 290 ${32 + index * 60}, 430 ${88 + index * 60}`}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="1"
          />
        ))}
      </g>

      <g opacity="0.16">
        <path d="M 20 108 C 72 92, 126 104, 180 86 S 300 68, 370 84" stroke="#FFFFFF" strokeWidth="2" fill="none" />
        <path d="M 22 216 C 76 194, 116 210, 168 186 S 272 158, 374 174" stroke="#FFFFFF" strokeWidth="2" fill="none" />
        <path d="M 18 322 C 82 300, 132 316, 186 286 S 298 260, 372 270" stroke="#FFFFFF" strokeWidth="2" fill="none" />
        <path d="M 26 438 C 84 418, 144 426, 204 394 S 304 366, 366 380" stroke="#FFFFFF" strokeWidth="2" fill="none" />
      </g>

      <g opacity="0.78">
        {MAP_SEGMENTS.map((segment) => {
          const color = qualityColor(segment.score);
          const isSelected = selected.id === segment.id;
          return (
            <g key={segment.id}>
              <path
                d={segment.d}
                fill="none"
                stroke={isSelected ? rgba(color, 0.18) : rgba(color, 0.12)}
                strokeWidth={isSelected ? 18 : 14}
                strokeLinecap="round"
                filter={isSelected ? "url(#softGlow)" : undefined}
              />
              <path
                d={segment.d}
                fill="none"
                stroke={color}
                strokeWidth={isSelected ? 8 : 6}
                strokeLinecap="round"
                filter={isSelected ? "url(#softGlow)" : undefined}
                opacity={emphasis === "surface" && segment.id === "c" ? 0.9 : 0.85}
              />
            </g>
          );
        })}
      </g>

      <path
        d="M 56 436 C 98 404, 136 392, 170 364 S 226 296, 252 262 S 292 202, 330 150"
        fill="none"
        stroke={rgba(C.road, 0.4)}
        strokeWidth="20"
        strokeLinecap="round"
      />
      <path
        d="M 56 436 C 98 404, 136 392, 170 364 S 226 296, 252 262 S 292 202, 330 150"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="2"
        strokeDasharray="5 10"
        strokeLinecap="round"
      />

      <circle cx="56" cy="436" r="14" fill={rgba(C.cyan, 0.18)} />
      <circle cx="56" cy="436" r="8" fill={C.cyan} />
      <path d="M 56 418 L 63 434 L 56 430 L 49 434 Z" fill={C.cyan} />

      <circle cx="323" cy="148" r="12" fill={rgba(C.fair, 0.2)} />
      <text x="323" y="152" fill={C.fair} fontSize="10" textAnchor="middle" fontWeight="800">
        !
      </text>

      <circle cx="211" cy="304" r="11" fill={rgba(C.poor, 0.18)} />
      <text x="211" y="308" fill={C.poor} fontSize="10" textAnchor="middle" fontWeight="800">
        !
      </text>

      <g opacity="0.92">
        {MAP_SEGMENTS.map((segment) => {
          const selectedTag = selected.id === segment.id;
          const color = qualityColor(segment.score);
          return (
            <g key={`label-${segment.id}`} transform={`translate(${segment.labelX}, ${segment.labelY})`}>
              <rect
                x={selectedTag ? -82 : -74}
                y="-18"
                rx="11"
                ry="11"
                width={selectedTag ? 164 : 148}
                height="36"
                fill={rgba(C.bg, 0.78)}
                stroke={selectedTag ? rgba(color, 0.4) : C.line}
              />
              <circle cx={-60} cy="0" r="4" fill={color} />
              <text x="-48" y="-2" fill={C.text} fontSize="10" fontWeight="800">
                {segment.name}
              </text>
              <text x="-48" y="10" fill={C.sub} fontSize="8" fontWeight="700">
                {qualityLabel(segment.score)}  {segment.confidence}% confidence
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function OverviewScene({ mode, onModeChange, onSceneChange }) {
  const preset = MODE_PRESETS[mode];
  const roads = ROAD_LIST[mode];

  return (
    <div style={{ height: "100%", overflow: "auto", background: `linear-gradient(180deg, ${C.bg2} 0%, ${C.bg} 24%, ${C.bg} 100%)` }}>
      <div style={{ padding: "16px 16px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.16em", color: C.sub, fontWeight: 800 }}>
              TARMOTO / LIVE ROUTE INTELLIGENCE
            </div>
            <div style={{ fontSize: 25, fontWeight: 900, color: C.text, letterSpacing: "-0.04em", marginTop: 4 }}>
              Ride ready?
            </div>
          </div>
          <div
            style={{
              borderRadius: 18,
              background: rgba(C.cyan, 0.08),
              border: `1px solid ${rgba(C.cyan, 0.18)}`,
              padding: "10px 12px",
              color: C.cyan,
              fontSize: 10,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            GPS locked
          </div>
        </div>

        <div style={{ display: "grid", gap: 10, marginBottom: 12, gridTemplateColumns: "repeat(3, 1fr)" }}>
          {MODE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onModeChange(key)}
              style={{
                border: `1px solid ${mode === key ? rgba(C.cyan, 0.44) : C.line}`,
                background: mode === key ? rgba(C.cyan, 0.12) : C.panel,
                borderRadius: 16,
                padding: "10px 8px",
                cursor: "pointer",
                color: mode === key ? C.text : C.sub,
                textAlign: "left",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", marginBottom: 4 }}>
                {key.toUpperCase()}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: mode === key ? C.cyan : C.sub }}>
                {MODE_PRESETS[key].title}
              </div>
            </button>
          ))}
        </div>

        <div
          style={{
            background: `linear-gradient(145deg, ${rgba(C.cyan, 0.10)} 0%, ${rgba("#FFFFFF", 0.02)} 45%, ${C.panel} 100%)`,
            border: `1px solid ${rgba(C.cyan, 0.16)}`,
            borderRadius: 24,
            padding: 16,
            marginBottom: 12,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              right: -48,
              top: -48,
              width: 146,
              height: 146,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${rgba(C.cyan, 0.24)} 0%, transparent 65%)`,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div style={{ maxWidth: 180 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.12em", color: C.sub, fontWeight: 800, marginBottom: 8 }}>
                ROAD QUALITY FIRST
              </div>
              <div style={{ fontSize: 18, color: C.text, fontWeight: 900, lineHeight: 1.05, marginBottom: 8 }}>
                {preset.title}
              </div>
              <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.5 }}>
                {preset.subtitle} and a route shaped by surface confidence.
              </div>
            </div>
            <QualityGauge score={preset.score} confidence={preset.confidence} />
          </div>

          <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.sub, fontWeight: 700 }}>Surface signal</span>
              <span style={{ color: qualityColor(preset.score), fontWeight: 800 }}>{qualityLabel(preset.score)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
              {["A", "B", "C", "D", "E"].map((band, index) => {
                const colors = [C.good, "#89D41F", C.fair, C.poor, C.danger];
                return (
                  <div
                    key={band}
                    style={{
                      height: 14,
                      borderRadius: 999,
                      background: index < Math.round(preset.score) ? colors[index] : rgba("#FFFFFF", 0.06),
                      boxShadow: index < Math.round(preset.score) ? `0 0 0 1px ${rgba(colors[index], 0.08)} inset` : "none",
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: C.sub, fontSize: 11, fontWeight: 700 }}>
              <span>{preset.surface}</span>
              <span>{preset.confidence}% confidence</span>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => onSceneChange("ride")}
            style={{
              border: "none",
              borderRadius: 20,
              background: `linear-gradient(160deg, ${C.cyan} 0%, ${C.good} 100%)`,
              color: "#041017",
              minHeight: 116,
              padding: 16,
              textAlign: "left",
              cursor: "pointer",
              boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.12em", opacity: 0.8, marginBottom: 10 }}>
              START RIDE
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.05 }}>
              Turn the road into a cockpit.
            </div>
            <div style={{ fontSize: 11, marginTop: 8, opacity: 0.78 }}>
              One tap launches nav, alerts, and surface context.
            </div>
          </button>

          <button
            type="button"
            onClick={() => onSceneChange("map")}
            style={{
              border: `1px solid ${C.line}`,
              borderRadius: 20,
              background: C.panel,
              color: C.text,
              minHeight: 116,
              padding: 16,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 11, color: C.sub, fontWeight: 900, letterSpacing: "0.12em", marginBottom: 10 }}>
              MAP INTELLIGENCE
            </div>
            <div style={{ fontSize: 18, fontWeight: 900, lineHeight: 1.08, marginBottom: 8 }}>
              Scan the asphalt before you commit.
            </div>
            <div style={{ fontSize: 11, color: C.sub }}>
              Segment confidence, hazard spots, and surface ranking.
            </div>
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 800, letterSpacing: "0.04em" }}>
              Nearby roads
            </div>
            <div style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>
              Updated live from rider passes
            </div>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {roads.map((road) => {
              const color = qualityColor(road.score);
              return (
                <div
                  key={road.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    background: C.panel,
                    border: `1px solid ${C.line}`,
                    borderRadius: 18,
                    padding: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 0 4px ${rgba(color, 0.12)}` }} />
                      <div style={{ color: C.text, fontWeight: 800, fontSize: 13 }}>{road.name}</div>
                    </div>
                    <div style={{ color: C.sub, fontSize: 11, lineHeight: 1.35 }}>
                      {road.surface}  <span style={{ color: C.dim }}>|</span> {road.note || preset.note}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ color: color, fontWeight: 900, fontSize: 18 }}>{road.score.toFixed(1)}</div>
                    <div style={{ color: C.sub, fontSize: 10, fontWeight: 700 }}>{road.confidence}%</div>
                    <div style={{ color: road.delta.startsWith("+") ? C.good : C.poor, fontSize: 10, fontWeight: 800 }}>
                      {road.delta}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.line}`,
            borderRadius: 20,
            padding: 14,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 800 }}>
              Live hazards
            </div>
            <div style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>
              Immediate rider warnings
            </div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {[
              { type: "Gravel", when: "1.1 km ahead", tone: C.fair },
              { type: "Fresh oil", when: "reported 8 min ago", tone: C.danger },
            ].map((hazard) => (
              <div
                key={hazard.type}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderRadius: 14,
                  padding: "10px 12px",
                  background: rgba(hazard.tone, 0.08),
                  border: `1px solid ${rgba(hazard.tone, 0.16)}`,
                }}
              >
                <div style={{ color: C.text, fontSize: 12, fontWeight: 800 }}>{hazard.type}</div>
                <div style={{ color: hazard.tone, fontSize: 11, fontWeight: 700 }}>{hazard.when}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MapScene({ selectedSegmentId, onSelectSegment, layer, onLayerChange }) {
  const selected = MAP_SEGMENTS.find((segment) => segment.id === selectedSegmentId) || MAP_SEGMENTS[0];
  const color = qualityColor(selected.score);

  return (
    <div style={{ position: "relative", height: "100%", background: C.bg, overflow: "hidden" }}>
      <MapCanvas selectedSegmentId={selectedSegmentId} emphasis={layer} />

      <div style={{ position: "absolute", inset: 0, padding: 14, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.14em", fontWeight: 800, marginBottom: 6 }}>
              MAP INTELLIGENCE
            </div>
            <div style={{ color: C.text, fontSize: 22, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1.05 }}>
              Surface quality made legible.
            </div>
          </div>
          <div
            style={{
              background: rgba(C.bg, 0.82),
              border: `1px solid ${rgba(color, 0.22)}`,
              borderRadius: 18,
              padding: "10px 12px",
              minWidth: 92,
              textAlign: "right",
            }}
          >
            <div style={{ color: color, fontSize: 18, fontWeight: 900 }}>{selected.score.toFixed(1)}</div>
            <div style={{ color: C.sub, fontSize: 10, fontWeight: 700 }}>{selected.confidence}% confidence</div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { id: "quality", label: "Quality" },
              { id: "surface", label: "Surface" },
              { id: "hazards", label: "Hazards" },
            ].map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => onLayerChange(chip.id)}
                style={{
                  border: `1px solid ${layer === chip.id ? rgba(C.cyan, 0.42) : C.line}`,
                  background: layer === chip.id ? rgba(C.cyan, 0.12) : rgba(C.bg, 0.72),
                  color: layer === chip.id ? C.cyan : C.sub,
                  borderRadius: 999,
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div
            style={{
              background: rgba(C.bg, 0.84),
              border: `1px solid ${C.line}`,
              borderRadius: 22,
              padding: 12,
              backdropFilter: "blur(16px)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.12em", fontWeight: 800, marginBottom: 4 }}>
                  SEGMENT INSPECTOR
                </div>
                <div style={{ color: C.text, fontSize: 16, fontWeight: 900 }}>{selected.name}</div>
                <div style={{ color: C.sub, fontSize: 11, marginTop: 4 }}>{selected.note}</div>
              </div>
              <QualityGauge score={selected.score} confidence={selected.confidence} compact />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              <MetricCard label="QUALITY" value={selected.score.toFixed(1)} hint={qualityLabel(selected.score)} accent={color} />
              <MetricCard label="CONFIDENCE" value={`${selected.confidence}%`} hint="sampled by riders" accent={C.cyan} />
              <MetricCard label="SURFACE" value={selected.surface} hint="segment type" accent={C.fair} />
            </div>
          </div>

          <RoadRibbon segments={MAP_SEGMENTS} selectedId={selectedSegmentId} onSelect={onSelectSegment} />
        </div>
      </div>
    </div>
  );
}

function RideScene({ rideMode, onRideModeChange }) {
  const [hudVisible, setHudVisible] = useState(true);
  const hideTimer = useRef(null);

  const resetHideTimer = useCallback(() => {
    setHudVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHudVisible(false), 4500);
  }, []);

  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [resetHideTimer, rideMode]);

  const rideState = {
    nav: {
      title: "Next turn",
      value: "Right sweeper in 220 m",
      note: "tightens after the bridge",
      big: "64",
      metric: "km/h",
      status: "Map stays open so the line ahead is readable.",
      accent: C.cyan,
      selectedSegmentId: "a",
      emphasis: "quality",
      roadScore: "4.6/5",
      confidence: "91%",
      hazard: "Loose gravel outer edge in 1.1 km",
      upcoming: [
        { distance: "220 m", label: "Right sweeper", meta: "medium radius", tone: C.cyan },
        { distance: "540 m", label: "Left opens up", meta: "clear exit view", tone: C.good },
        { distance: "1.1 km", label: "Gravel edge", meta: "caution marker", tone: C.fair },
      ],
    },
    surface: {
      title: "Road surface",
      value: "4.6 / 5",
      note: "Excellent asphalt, 18 rider passes",
      big: "4.6",
      metric: "score",
      status: "Surface signal stays visible without covering the route.",
      accent: C.good,
      selectedSegmentId: "b",
      emphasis: "surface",
      roadScore: "4.8/5",
      confidence: "94%",
      hazard: "Patchy connector after the ridge in 800 m",
      upcoming: [
        { distance: "180 m", label: "Fast right", meta: "smooth entry", tone: C.good },
        { distance: "480 m", label: "Long left", meta: "excellent asphalt", tone: C.good },
        { distance: "800 m", label: "Patch zone", meta: "watch mid-corner seam", tone: C.poor },
      ],
    },
    safety: {
      title: "Safety watch",
      value: "Loose gravel ahead",
      note: "1.1 km and closing",
      big: "!",
      metric: "alert",
      status: "Hazards stay at the edge so the map remains the main view.",
      accent: C.fair,
      selectedSegmentId: "c",
      emphasis: "quality",
      roadScore: "3.8/5",
      confidence: "88%",
      hazard: "Loose gravel on outer line, reported 8 min ago",
      upcoming: [
        { distance: "120 m", label: "Blind left", meta: "reduced exit view", tone: C.fair },
        { distance: "460 m", label: "Roadworks lip", meta: "short rough section", tone: C.poor },
        { distance: "1.1 km", label: "Loose gravel", meta: "outer line hazard", tone: C.fair },
      ],
    },
  }[rideMode];

  return (
    <div
      style={{ position: "relative", height: "100%", background: "#05070B", overflow: "hidden" }}
      onPointerDown={resetHideTimer}
    >
      <MapCanvas selectedSegmentId={rideState.selectedSegmentId} emphasis={rideState.emphasis} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 42%, rgba(5,7,11,0.03), transparent 28%), linear-gradient(180deg, rgba(5,7,11,0.18) 0%, rgba(5,7,11,0.04) 24%, rgba(5,7,11,0.04) 62%, rgba(5,7,11,0.42) 100%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: 14,
          opacity: hudVisible ? 1 : 0,
          transition: "opacity 220ms ease",
          pointerEvents: hudVisible ? "auto" : "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div
            style={{
              background: rgba(C.bg, 0.76),
              border: `1px solid ${C.line}`,
              borderRadius: 16,
              padding: "9px 12px",
              minWidth: 176,
              maxWidth: 188,
              backdropFilter: "blur(14px)",
            }}
          >
            <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.12em", fontWeight: 800, marginBottom: 5 }}>
              {rideState.title.toUpperCase()}
            </div>
            <div style={{ color: C.text, fontSize: 16, fontWeight: 900, lineHeight: 1.1 }}>
              {rideState.value}
            </div>
            <div style={{ color: C.sub, fontSize: 11, marginTop: 4 }}>{rideState.note}</div>
          </div>

          <div
            style={{
              background: rgba(C.bg, 0.76),
              border: `1px solid ${rgba(rideState.accent, 0.24)}`,
              borderRadius: 999,
              padding: "10px 12px",
              minWidth: 82,
              textAlign: "center",
              backdropFilter: "blur(14px)",
            }}
          >
            <div style={{ color: C.sub, fontSize: 9, fontWeight: 800, letterSpacing: "0.12em" }}>SPEED</div>
            <div style={{ color: C.text, fontSize: 32, fontWeight: 900, lineHeight: 1, marginTop: 4 }}>
              {rideState.big}
            </div>
            <div style={{ color: C.sub, fontSize: 10, fontWeight: 700, marginTop: 2 }}>
              {rideState.metric}
            </div>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 14,
            top: 106,
            display: "grid",
            gap: 8,
            width: 76,
          }}
        >
          {[
            { id: "nav", label: "Nav" },
            { id: "surface", label: "Road" },
            { id: "safety", label: "Risk" },
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onRideModeChange(chip.id)}
              style={{
                borderRadius: 16,
                border: `1px solid ${rideMode === chip.id ? rgba(rideState.accent, 0.46) : C.line}`,
                background: rideMode === chip.id ? rgba(rideState.accent, 0.12) : rgba(C.bg, 0.62),
                color: rideMode === chip.id ? rideState.accent : C.sub,
                padding: "12px 8px",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.05em",
                backdropFilter: "blur(12px)",
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div
          style={{
            position: "absolute",
            right: 14,
            top: 114,
            width: 132,
            background: rgba(C.bg, 0.76),
            border: `1px solid ${rgba(rideState.accent, 0.18)}`,
            borderRadius: 18,
            padding: 10,
            backdropFilter: "blur(14px)",
          }}
        >
          <div style={{ color: C.sub, fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", marginBottom: 8 }}>
            LOOK AHEAD
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {rideState.upcoming.map((item) => (
              <div
                key={`${item.distance}-${item.label}`}
                style={{
                  padding: "8px 9px",
                  borderRadius: 12,
                  background: rgba(item.tone, 0.08),
                  border: `1px solid ${rgba(item.tone, 0.14)}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
                  <span style={{ color: C.text, fontSize: 11, fontWeight: 800 }}>{item.label}</span>
                  <span style={{ color: item.tone, fontSize: 10, fontWeight: 800 }}>{item.distance}</span>
                </div>
                <div style={{ color: C.sub, fontSize: 10, lineHeight: 1.25 }}>{item.meta}</div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 14,
            right: 14,
            bottom: 16,
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              background: rgba(C.bg, 0.76),
              border: `1px solid ${rgba(rideState.accent, 0.2)}`,
              borderRadius: 16,
              padding: "10px 12px",
              backdropFilter: "blur(14px)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 6 }}>
              <div style={{ color: C.text, fontSize: 13, fontWeight: 900 }}>
                {rideState.status}
              </div>
              <div style={{ color: rideState.accent, fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                {rideState.confidence}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              <MetricCard label="LEAN" value="28 deg" hint="steady cornering" accent={C.fair} />
              <MetricCard label="DIST" value="23.4 km" hint="ride progress" accent={C.cyan} />
              <MetricCard label="ROAD" value={rideState.roadScore} hint={rideState.hazard} accent={rideState.accent} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {[
              {
                label: "Report",
                tone: C.fair,
                border: rgba(C.fair, 0.24),
                bg: rgba(C.fair, 0.1),
              },
              {
                label: "Voice",
                tone: C.cyan,
                border: rgba(C.cyan, 0.22),
                bg: rgba(C.cyan, 0.08),
              },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                style={{
                  flex: 1,
                  borderRadius: 16,
                  border: `1px solid ${action.border}`,
                  background: action.bg,
                  color: action.tone,
                  padding: "12px 10px",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: "pointer",
                  backdropFilter: "blur(12px)",
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              style={{
                width: 58,
                borderRadius: 16,
                border: `1px solid ${rgba(C.danger, 0.26)}`,
                background: rgba(C.danger, 0.1),
                color: C.danger,
                fontSize: 18,
                fontWeight: 900,
                cursor: "pointer",
                backdropFilter: "blur(12px)",
              }}
            >
              X
            </button>
          </div>
        </div>
      </div>

      {!hudVisible && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            background: "rgba(5,7,11,0.68)",
            border: `1px solid ${C.line}`,
            borderRadius: 999,
            padding: "8px 14px",
            backdropFilter: "blur(12px)",
            boxShadow: "0 12px 36px rgba(0,0,0,0.28)",
          }}
        >
          <div style={{ color: C.sub, fontSize: 11, fontWeight: 800, letterSpacing: "0.04em" }}>
            Tap to show controls
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewScene({ reportType, onReportTypeChange }) {
  const selected = REPORT_TYPES.find((item) => item.id === reportType) || REPORT_TYPES[0];

  return (
    <div style={{ height: "100%", overflow: "auto", background: `linear-gradient(180deg, ${C.bg2} 0%, ${C.bg} 24%, ${C.bg} 100%)` }}>
      <div style={{ padding: "16px 16px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.14em", fontWeight: 800, marginBottom: 6 }}>
              RIDE REVIEW
            </div>
            <div style={{ color: C.text, fontSize: 24, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1.05 }}>
              A post-ride summary that helps the road get better.
            </div>
          </div>
        </div>

        <div
          style={{
            background: `linear-gradient(145deg, ${rgba(C.cyan, 0.08)} 0%, ${C.panel} 62%, ${C.panel2} 100%)`,
            border: `1px solid ${C.line}`,
            borderRadius: 24,
            padding: 16,
            marginBottom: 12,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.12em", fontWeight: 800, marginBottom: 6 }}>
                LAST RIDE
              </div>
              <div style={{ color: C.text, fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
                Morning commute
              </div>
              <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.45 }}>
                23.4 km  |  34 min  |  4.6 road score
              </div>
            </div>
            <QualityGauge score={4.6} confidence={94} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <MetricCard label="DIST" value="23.4 km" hint="sampled" accent={C.cyan} />
            <MetricCard label="TIME" value="34 min" hint="moving" accent={C.good} />
            <MetricCard label="MAX" value="94 km/h" hint="top speed" accent={C.fair} />
            <MetricCard label="LEAN" value="28 deg" hint="max lean" accent={C.danger} />
          </div>
        </div>

        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.line}`,
            borderRadius: 22,
            padding: 14,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 800 }}>
              Surface trace
            </div>
            <div style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>
              quality by segment
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(18, 1fr)", gap: 4, alignItems: "end", minHeight: 82 }}>
            {[
              4.7, 4.9, 4.8, 4.3, 4.1, 3.8, 4.0, 4.4, 4.7, 4.9, 4.2, 3.4, 3.1, 3.7, 4.5, 4.6, 4.4, 4.8,
            ].map((value, index) => {
              const color = qualityColor(value);
              return (
                <div
                  key={index}
                  style={{
                    height: `${Math.max(16, value * 14)}px`,
                    borderRadius: 8,
                    background: color,
                    opacity: index === 11 || index === 12 ? 1 : 0.88,
                    boxShadow: index === 11 || index === 12 ? `0 0 0 1px ${rgba(color, 0.18)} inset` : "none",
                  }}
                />
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, color: C.sub, fontSize: 10, fontWeight: 700 }}>
            <span>Best stretch at the ridge</span>
            <span>Rough patch in the valley connector</span>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 800 }}>
              What changed?
            </div>
            <div style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>
              Pick a report type
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10 }}>
            {REPORT_TYPES.map((item) => {
              const active = reportType === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onReportTypeChange(item.id)}
                  style={{
                    borderRadius: 16,
                    border: `1px solid ${active ? rgba(item.tone, 0.44) : C.line}`,
                    background: active ? rgba(item.tone, 0.12) : C.panel,
                    color: active ? item.tone : C.sub,
                    padding: "10px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div
            style={{
              background: rgba(selected.tone, 0.08),
              border: `1px solid ${rgba(selected.tone, 0.18)}`,
              borderRadius: 20,
              padding: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <div>
                <div style={{ color: C.sub, fontSize: 10, letterSpacing: "0.12em", fontWeight: 800, marginBottom: 6 }}>
                  REPORT DRAFT
                </div>
                <div style={{ color: C.text, fontSize: 18, fontWeight: 900 }}>
                  {selected.label} on the outer line
                </div>
              </div>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 18,
                  background: rgba(selected.tone, 0.14),
                  border: `1px solid ${rgba(selected.tone, 0.22)}`,
                  color: selected.tone,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  fontWeight: 900,
                }}
              >
                !
              </div>
            </div>

            <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.45, marginBottom: 12 }}>
              {selected.id === "gravel" && "Loose gravel was visible near the apex. This is the kind of detail riders can use before they commit to the route."}
              {selected.id === "pothole" && "A deeper dip sits just after the bend. Flagging it improves the next rider's line and route confidence."}
              {selected.id === "oil" && "Fresh oil on the turn-in is a high-risk surface warning. The report should stay visible until riders confirm it is cleared."}
              {selected.id === "roadworks" && "Short-term roadworks often change the whole riding line. This report helps the route engine avoid the weak section."}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={{
                  flex: 1,
                  borderRadius: 16,
                  border: `1px solid ${rgba(selected.tone, 0.24)}`,
                  background: selected.tone === C.cyan ? rgba(C.cyan, 0.1) : rgba(selected.tone, 0.08),
                  color: selected.tone,
                  padding: "12px 10px",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Submit report
              </button>
              <button
                type="button"
                style={{
                  flex: 1,
                  borderRadius: 16,
                  border: `1px solid ${C.line}`,
                  background: C.panel2,
                  color: C.text,
                  padding: "12px 10px",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Save ride
              </button>
            </div>
          </div>
        </div>

        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.line}`,
            borderRadius: 22,
            padding: 14,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 800 }}>
              Surface distribution
            </div>
            <div style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>
              community readable at a glance
            </div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {REVIEW_BANDS.map((band) => (
              <div key={band.label}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>{band.label}</span>
                  <span style={{ color: C.text, fontSize: 11, fontWeight: 800 }}>{band.value}%</span>
                </div>
                <div style={{ height: 10, borderRadius: 999, background: rgba("#FFFFFF", 0.06), overflow: "hidden" }}>
                  <div style={{ width: `${band.value}%`, height: "100%", borderRadius: 999, background: band.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneFrame({ children, scene }) {
  return (
    <div
      style={{
        width: "min(428px, 100%)",
        aspectRatio: "390 / 844",
        background: `linear-gradient(180deg, ${C.frame} 0%, #06080D 100%)`,
        borderRadius: 42,
        padding: 12,
        boxShadow: "0 30px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      <div
        style={{
          height: "100%",
          borderRadius: 32,
          overflow: "hidden",
          background: C.bg,
          position: "relative",
          border: `1px solid ${rgba("#FFFFFF", 0.04)}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            width: 124,
            height: 26,
            borderRadius: 20,
            background: "rgba(0,0,0,0.62)",
            border: "1px solid rgba(255,255,255,0.05)",
            zIndex: 10,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: "radial-gradient(circle at 30% 0%, rgba(98,230,224,0.12), transparent 34%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.05), transparent 26%)",
          }}
        />
        {children}
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            width: scene === "ride" ? 96 : 118,
            height: 4,
            borderRadius: 999,
            background: "rgba(255,255,255,0.18)",
            opacity: scene === "ride" ? 0.6 : 0.85,
          }}
        />
      </div>
    </div>
  );
}

export default function TarmotoMobileConceptV2() {
  const [scene, setScene] = useState("overview");
  const [overviewMode, setOverviewMode] = useState("commute");
  const [selectedSegmentId, setSelectedSegmentId] = useState("b");
  const [layer, setLayer] = useState("quality");
  const [rideMode, setRideMode] = useState("nav");
  const [reportType, setReportType] = useState("gravel");

  const sceneDescriptions = {
    overview: "Route intelligence first, with commute shortcuts and live hazards surfaced up front.",
    map: "Quality overlays, segment confidence, and a map that makes road condition legible.",
    ride: "A cockpit-style ride mode with turn guidance, surface signal, and hazard awareness.",
    review: "A post-ride summary that turns every session into useful road intelligence.",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "28px 18px 36px",
        background: `radial-gradient(circle at 18% 16%, rgba(98,230,224,0.14), transparent 26%), radial-gradient(circle at 82% 18%, rgba(255,255,255,0.06), transparent 24%), linear-gradient(180deg, #05070B 0%, #070B10 50%, #05070B 100%)`,
        color: C.text,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "min(1120px, 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 720 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 18,
                background: `linear-gradient(145deg, ${rgba(C.cyan, 0.24)} 0%, ${rgba(C.good, 0.2)} 100%)`,
                border: `1px solid ${rgba(C.cyan, 0.22)}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: `0 16px 50px ${rgba(C.cyan, 0.12)}`,
              }}
            >
              <div style={{ width: 22, height: 22, borderRadius: 8, border: `3px solid ${C.cyan}`, position: "relative" }}>
                <div style={{ position: "absolute", left: -5, top: 8, width: 30, height: 3, background: C.cyan, borderRadius: 999 }} />
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, letterSpacing: "0.16em", color: C.sub, fontWeight: 800, marginBottom: 6 }}>
            TARMOTO MOBILE CONCEPT V2
          </div>
          <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-0.05em", lineHeight: 1.05, marginBottom: 8 }}>
            A fresher mobile direction for road quality, live alerts, ride mode, and review.
          </div>
          <div style={{ color: C.sub, fontSize: 13, lineHeight: 1.6 }}>
            This concept leans into a cockpit-like visual language so the road score, hazard confidence, and ride state are readable at a glance.
          </div>
        </div>

        <div
          style={{
            width: "min(980px, 100%)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          {SCENES.map((item) => (
            <SceneTab
              key={item.id}
              active={scene === item.id}
              label={item.label}
              note={item.note}
              onClick={() => setScene(item.id)}
            />
          ))}
        </div>

        <div
          style={{
            width: "min(980px, 100%)",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <PhoneFrame scene={scene}>
            {scene === "overview" && (
              <OverviewScene
                mode={overviewMode}
                onModeChange={setOverviewMode}
                onSceneChange={setScene}
              />
            )}
            {scene === "map" && (
              <MapScene
                selectedSegmentId={selectedSegmentId}
                onSelectSegment={setSelectedSegmentId}
                layer={layer}
                onLayerChange={setLayer}
              />
            )}
            {scene === "ride" && <RideScene rideMode={rideMode} onRideModeChange={setRideMode} />}
            {scene === "review" && <ReviewScene reportType={reportType} onReportTypeChange={setReportType} />}
          </PhoneFrame>
        </div>

        <div style={{ maxWidth: 760, textAlign: "center" }}>
          <div style={{ color: C.text, fontSize: 14, fontWeight: 800, marginBottom: 6 }}>
            {SCENES.find((item) => item.id === scene)?.label}
          </div>
          <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.55 }}>
            {sceneDescriptions[scene]}
          </div>
        </div>
      </div>
    </div>
  );
}
