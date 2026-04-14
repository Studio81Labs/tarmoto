import { useState, useEffect } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area } from "recharts";

// ── Brand tokens ──
const C = {
  cyan: "#0ED3CF",
  cyanLight: "#5DE5E2",
  cyanDark: "#0AA8A5",
  bg: "#0B1120",
  surface: "#111827",
  surfaceHover: "#1E293B",
  border: "#1E293B",
  borderLight: "#334155",
  text: "#F8FAFC",
  textMuted: "#94A3B8",
  textDim: "#64748B",
  excellent: "#22C55E",
  good: "#84CC16",
  fair: "#EAB308",
  poor: "#F97316",
  veryPoor: "#EF4444",
};

const qualityColors = [C.excellent, C.good, C.fair, C.poor, C.veryPoor];

// ── Sample data ──
const RIDES = [
  { id: 1, name: "Beskydy Morning Loop", date: "2026-04-12", km: 127.4, duration: "2h 48m", avgSpeed: 45, maxSpeed: 112, elevation: 1840, quality: { excellent: 35, good: 40, fair: 15, poor: 8, veryPoor: 2 } },
  { id: 2, name: "Ostravice Valley Run", date: "2026-04-10", km: 84.2, duration: "1h 52m", avgSpeed: 45, maxSpeed: 98, elevation: 920, quality: { excellent: 50, good: 30, fair: 12, poor: 6, veryPoor: 2 } },
  { id: 3, name: "Frýdek-Místek Commute", date: "2026-04-09", km: 32.1, duration: "0h 42m", avgSpeed: 46, maxSpeed: 78, elevation: 180, quality: { excellent: 60, good: 25, fair: 10, poor: 5, veryPoor: 0 } },
  { id: 4, name: "Lysá Hora Summit Road", date: "2026-04-06", km: 96.8, duration: "2h 15m", avgSpeed: 43, maxSpeed: 105, elevation: 1520, quality: { excellent: 20, good: 35, fair: 25, poor: 15, veryPoor: 5 } },
  { id: 5, name: "Weekend Štramberk Loop", date: "2026-04-05", km: 142.3, duration: "3h 10m", avgSpeed: 45, maxSpeed: 118, elevation: 2100, quality: { excellent: 45, good: 35, fair: 12, poor: 6, veryPoor: 2 } },
];

const MONTHLY_STATS = [
  { month: "Nov", km: 320 }, { month: "Dec", km: 85 }, { month: "Jan", km: 40 },
  { month: "Feb", km: 120 }, { month: "Mar", km: 580 }, { month: "Apr", km: 480 },
];

const ELEVATION_DATA = Array.from({ length: 60 }, (_, i) => ({
  d: i * 2,
  e: 300 + Math.sin(i * 0.15) * 200 + Math.sin(i * 0.4) * 80 + Math.random() * 30,
}));

const SPEED_DATA = Array.from({ length: 60 }, (_, i) => ({
  t: i,
  s: 30 + Math.sin(i * 0.2) * 25 + Math.random() * 15,
}));

const SEGMENTS = [
  { name: "Čeladná → Kunčice", km: 12.4, quality: 4.8, curviness: 82, elevation: "+340m", hazards: 0, surface: "Asphalt" },
  { name: "Kunčice → Ostravice", km: 8.7, quality: 4.2, curviness: 65, elevation: "+120m", hazards: 1, surface: "Asphalt" },
  { name: "Ostravice → Bílá", km: 15.2, quality: 3.1, curviness: 91, elevation: "+580m", hazards: 2, surface: "Asphalt" },
  { name: "Bílá → Staré Hamry", km: 11.8, quality: 3.8, curviness: 74, elevation: "+210m", hazards: 0, surface: "Asphalt" },
  { name: "Staré Hamry → Morávka", km: 9.3, quality: 2.4, curviness: 88, elevation: "+390m", hazards: 3, surface: "Mixed" },
];

const HAZARDS = [
  { type: "Pothole", location: "Čeladná, km 3.2", severity: "high", time: "2h ago", confirmations: 5 },
  { type: "Gravel", location: "Bílá pass, km 12.1", severity: "medium", time: "6h ago", confirmations: 3 },
  { type: "Roadworks", location: "Ostravice bridge", severity: "low", time: "1d ago", confirmations: 12 },
  { type: "Oil spill", location: "Morávka hairpin", severity: "high", time: "4h ago", confirmations: 2 },
];

// ── Icons (inline SVG) ──
const Icon = ({ d, size = 18, color = "currentColor", ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d={d} />
  </svg>
);
const Icons = {
  home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M9 22V12h6v10",
  map: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z M8 2v16 M16 6v16",
  route: "M12 22s-8-4.5-8-11.8A8 8 0 0112 2a8 8 0 018 8.2c0 7.3-8 11.8-8 11.8z M12 10a1 1 0 100-2 1 1 0 000 2z",
  history: "M12 8v4l3 3 M3 12a9 9 0 1018 0 9 9 0 00-18 0z",
  chart: "M18 20V10 M12 20V4 M6 20v-6",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 7a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  plus: "M12 5v14 M5 12h14",
  spark: "M12 2L9 12l-7 1 5 5-1 7 6-4 6 4-1-7 5-5-7-1z",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  upload: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  layers: "M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
  sliders: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  chevRight: "M9 18l6-6-6-6",
  chevLeft: "M15 18l-6-6 6-6",
  bell: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9z M13.73 21a2 2 0 01-3.46 0",
  bike: "M5 19a4 4 0 100-8 4 4 0 000 8z M19 19a4 4 0 100-8 4 4 0 000 8z M12 15l-3-8h7l1 4",
  alert: "M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
  mapPin: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 7a3 3 0 100 6 3 3 0 000-6z",
  grip: "M8 6h.01 M8 12h.01 M8 18h.01 M16 6h.01 M16 12h.01 M16 18h.01",
  share: "M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8 M16 6l-4-4-4 4 M12 2v13",
  arrowRight: "M5 12h14 M12 5l7 7-7 7",
};

// ── Quality helpers ──
const qualityTier = (s) => s >= 4.5 ? 0 : s >= 3.5 ? 1 : s >= 2.5 ? 2 : s >= 1.5 ? 3 : 4;
const qualityLabel = ["Excellent", "Good", "Fair", "Poor", "Very Poor"];
const qualityColor = (s) => qualityColors[qualityTier(s)];
const severityColor = { high: C.veryPoor, medium: C.fair, low: C.good };
const hazardEmoji = { Pothole: "🕳️", Gravel: "🪨", Roadworks: "🚧", "Oil spill": "🛢️", Animals: "🦌", Police: "👮", Flooding: "🌊", Ice: "🧊" };

// ── Simulated Map Component ──
function SimMap({ children, overlay, style: s }) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#0a0f1a", overflow: "hidden", ...s }}>
      {/* Topo grid */}
      <svg width="100%" height="100%" style={{ position: "absolute", opacity: 0.06 }}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#0ED3CF" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
      {/* Simulated roads */}
      <svg width="100%" height="100%" style={{ position: "absolute" }} viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
        <path d="M50,350 Q200,300 300,200 T500,180 T700,250" stroke={C.excellent} strokeWidth="3" fill="none" opacity="0.6" />
        <path d="M100,400 Q250,350 350,280 T550,300" stroke={C.good} strokeWidth="3" fill="none" opacity="0.6" />
        <path d="M200,100 Q300,150 400,250 T600,350 T750,400" stroke={C.fair} strokeWidth="2.5" fill="none" opacity="0.5" />
        <path d="M150,450 Q300,400 450,350 T700,300" stroke={C.excellent} strokeWidth="3" fill="none" opacity="0.6" />
        <path d="M50,200 Q150,250 250,300 T450,280" stroke={C.poor} strokeWidth="2" fill="none" opacity="0.4" />
        <path d="M300,50 Q400,100 500,200 T650,150" stroke={C.good} strokeWidth="2.5" fill="none" opacity="0.5" />
        {/* Fun zone glow */}
        <circle cx="400" cy="230" r="80" fill={C.cyan} opacity="0.04" />
        <circle cx="400" cy="230" r="50" fill={C.cyan} opacity="0.06" />
        {/* Hazard markers */}
        <circle cx="320" cy="210" r="5" fill={C.veryPoor} opacity="0.8" />
        <circle cx="520" cy="290" r="5" fill={C.fair} opacity="0.8" />
        <circle cx="450" cy="340" r="5" fill={C.veryPoor} opacity="0.8" />
        {/* Waypoint markers */}
        <circle cx="150" cy="380" r="7" fill={C.cyan} stroke="#fff" strokeWidth="2" />
        <circle cx="400" cy="200" r="7" fill={C.cyan} stroke="#fff" strokeWidth="2" />
        <circle cx="680" cy="270" r="7" fill={C.cyan} stroke="#fff" strokeWidth="2" />
      </svg>
      {overlay}
      {children}
    </div>
  );
}

// ── Glass Panel ──
function Glass({ children, style, className, ...props }) {
  return (
    <div style={{ background: "rgba(17,24,39,0.85)", backdropFilter: "blur(16px)", border: `1px solid ${C.border}`, borderRadius: 16, ...style }} {...props}>
      {children}
    </div>
  );
}

// ── Quality Badge ──
function QBadge({ score, size = "sm" }) {
  const s = size === "lg" ? { fontSize: 16, padding: "4px 12px" } : { fontSize: 11, padding: "2px 8px" };
  return (
    <span style={{ ...s, borderRadius: 8, fontWeight: 700, color: qualityColor(score), background: qualityColor(score) + "18" }}>
      {score.toFixed(1)}
    </span>
  );
}

// ── Curviness bar ──
function CurvBar({ value }) {
  return (
    <div style={{ width: 60, height: 4, borderRadius: 2, background: C.border }}>
      <div style={{ width: `${value}%`, height: "100%", borderRadius: 2, background: C.cyan, transition: "width 0.5s" }} />
    </div>
  );
}

// ── Main App ──
export default function TarmotoDashboard() {
  const [page, setPage] = useState("home");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedRide, setSelectedRide] = useState(null);
  const [tripSidebar, setTripSidebar] = useState(true);
  const [tripParams, setTripParams] = useState(true);
  const [explorerFilter, setExplorerFilter] = useState(true);
  const [animIn, setAnimIn] = useState(false);

  useEffect(() => { setAnimIn(false); const t = setTimeout(() => setAnimIn(true), 30); return () => clearTimeout(t); }, [page]);

  const sw = collapsed ? 56 : 220;

  const navItems = [
    { id: "home", icon: Icons.home, label: "Home" },
    { id: "planner", icon: Icons.route, label: "Trip Planner" },
    { id: "explorer", icon: Icons.map, label: "Road Explorer" },
    { id: "rides", icon: Icons.history, label: "Ride History" },
    { id: "stats", icon: Icons.chart, label: "Statistics" },
    { id: "community", icon: Icons.users, label: "Community" },
    { id: "settings", icon: Icons.settings, label: "Settings" },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", background: C.bg, color: C.text, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 13, overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      {/* ── Sidebar ── */}
      <aside style={{ width: sw, minWidth: sw, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, background: C.bg, transition: "width 0.25s, min-width 0.25s", overflow: "hidden" }}>
        {/* Logo */}
        <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: collapsed ? "0 16px" : "0 16px", borderBottom: `1px solid ${C.border}` }}>
          {!collapsed && <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: -0.5 }}><span style={{ color: C.cyan }}>T</span>armoto</span>}
          <button onClick={() => setCollapsed(!collapsed)} style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", padding: 4 }}>
            <Icon d={collapsed ? Icons.chevRight : Icons.chevLeft} size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {navItems.map((item) => {
            const active = page === item.id;
            return (
              <button key={item.id} onClick={() => { setPage(item.id); setSelectedRide(null); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: collapsed ? "9px 0" : "9px 12px",
                  justifyContent: collapsed ? "center" : "flex-start",
                  borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 500,
                  color: active ? C.cyan : C.textMuted, background: active ? C.cyan + "12" : "transparent",
                  transition: "all 0.15s", fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.surfaceHover; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <Icon d={item.icon} size={18} color={active ? C.cyan : C.textDim} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* User */}
        <div style={{ borderTop: `1px solid ${C.border}`, padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.cyan + "22", display: "flex", alignItems: "center", justifyContent: "center", color: C.cyan, fontWeight: 800, fontSize: 13, flexShrink: 0 }}>A</div>
          {!collapsed && <div><div style={{ fontWeight: 600, fontSize: 12 }}>Adam</div><div style={{ fontSize: 10, color: C.textDim }}>Premium</div></div>}
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        {page !== "planner" && page !== "explorer" && (
          <header style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>
              {navItems.find(n => n.id === page)?.label ?? "Dashboard"}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button style={{ position: "relative", background: "none", border: "none", color: C.textDim, cursor: "pointer" }}>
                <Icon d={Icons.bell} size={18} />
                <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: "50%", background: C.cyan }} />
              </button>
            </div>
          </header>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: page === "planner" || page === "explorer" ? "hidden" : "auto", opacity: animIn ? 1 : 0, transform: animIn ? "none" : "translateY(6px)", transition: "opacity 0.25s, transform 0.25s" }}>
          {page === "home" && <HomePage onNavigate={setPage} />}
          {page === "planner" && <TripPlannerPage sidebar={tripSidebar} setSidebar={setTripSidebar} params={tripParams} setParams={setTripParams} />}
          {page === "explorer" && <ExplorerPage filter={explorerFilter} setFilter={setExplorerFilter} />}
          {page === "rides" && !selectedRide && <RideListPage onSelect={setSelectedRide} />}
          {page === "rides" && selectedRide && <RideDetailPage ride={selectedRide} onBack={() => setSelectedRide(null)} />}
          {page === "stats" && <StatsPage />}
          {page === "community" && <CommunityPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════
// HOME PAGE
// ═══════════════════════════════════════════
function HomePage({ onNavigate }) {
  const quickActions = [
    { icon: Icons.plus, label: "Plan a trip", color: C.cyan, page: "planner" },
    { icon: Icons.map, label: "Explore roads", color: "#3B82F6", page: "explorer" },
    { icon: Icons.history, label: "Ride history", color: "#A78BFA", page: "rides" },
    { icon: Icons.chart, label: "My stats", color: "#F97316", page: "stats" },
  ];

  const stats = [
    { label: "Total distance", value: "2,847", unit: "km" },
    { label: "Total rides", value: "43", unit: "" },
    { label: "Roads discovered", value: "312", unit: "" },
    { label: "Hazards reported", value: "28", unit: "" },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Welcome back, Adam</h1>
      <p style={{ color: C.textDim, marginBottom: 24 }}>Here's what's happening on your roads.</p>

      {/* Quick actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
        {quickActions.map((a) => (
          <button key={a.label} onClick={() => onNavigate(a.page)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 16px", borderRadius: 16, border: `1px solid ${C.border}`, background: C.surface, cursor: "pointer", color: C.text, fontFamily: "inherit", transition: "all 0.15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.borderLight; e.currentTarget.style.transform = "translateY(-2px)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "none"; }}
          >
            <Icon d={a.icon} size={26} color={a.color} />
            <span style={{ fontSize: 12, fontWeight: 600, color: C.textMuted }}>{a.label}</span>
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ padding: "16px 20px", borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5 }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{s.value} <span style={{ fontSize: 12, fontWeight: 500, color: C.textDim }}>{s.unit}</span></div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Recent rides */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700 }}>Recent rides</h2>
            <button onClick={() => onNavigate("rides")} style={{ fontSize: 11, color: C.cyan, background: "none", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>View all →</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {RIDES.slice(0, 3).map((r) => (
              <div key={r.id} style={{ padding: "12px 16px", borderRadius: 12, background: C.surface, border: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{r.date} • {r.km} km • {r.duration}</div>
                </div>
                <QBadge score={Object.entries(r.quality).reduce((acc, [k, v]) => acc + ({ excellent: 5, good: 4, fair: 3, poor: 2, veryPoor: 1 }[k] || 3) * v, 0) / 100} />
              </div>
            ))}
          </div>
        </div>

        {/* Monthly km chart */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Monthly distance</h2>
          <div style={{ padding: 20, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}`, height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={MONTHLY_STATS} barSize={20}>
                <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="km" fill={C.cyan} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// TRIP PLANNER PAGE
// ═══════════════════════════════════════════
function TripPlannerPage({ sidebar, setSidebar, params, setParams }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: `1px solid ${C.border}`, background: C.bg, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, marginRight: 12 }}>Beskydy 3-Day Loop</span>
          <Btn icon={Icons.spark} label="Generate" primary />
          <Btn icon={Icons.upload} label="Import GPX" />
          <Btn icon={Icons.download} label="Export" />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn icon={Icons.sliders} label="Parameters" active={params} onClick={() => setParams(!params)} />
          <Btn icon={Icons.users} label="Collaborate" />
          <Btn icon={Icons.layers} label="Segments" active={sidebar} onClick={() => setSidebar(!sidebar)} />
        </div>
      </div>

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Params panel */}
        {params && (
          <div style={{ width: 240, borderRight: `1px solid ${C.border}`, background: C.bg, padding: 16, overflowY: "auto", flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 16 }}>Trip parameters</div>
            {[
              { label: "Number of days", type: "number", value: "3" },
              { label: "Daily km target", type: "number", value: "250" },
            ].map((f) => (
              <div key={f.label} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4, fontWeight: 600 }}>{f.label}</div>
                <input value={f.value} readOnly style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }} />
              </div>
            ))}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4, fontWeight: 600 }}>Road preference</div>
              <select style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }}>
                <option>Mixed (balanced)</option>
                <option>Maximum curviness</option>
                <option>Scenic roads</option>
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4, fontWeight: 600 }}>Minimum road quality</div>
              <select style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" }}>
                <option>Good or better</option>
                <option>Fair or better</option>
                <option>Excellent only</option>
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
              {["Avoid highways", "Avoid tolls", "Avoid unpaved"].map((label, i) => (
                <label key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textMuted, cursor: "pointer" }}>
                  <input type="checkbox" defaultChecked={i !== 1} style={{ accentColor: C.cyan }} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Map */}
        <SimMap>
          {/* Fun Zone label */}
          <Glass style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", padding: "6px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.cyan, animation: "pulse 2s infinite" }} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>Fun Zone: Beskydy Ridge • Score: 87</span>
          </Glass>
          {/* Map controls */}
          <div style={{ position: "absolute", bottom: 16, right: 16, display: "flex", flexDirection: "column", gap: 4 }}>
            {["+", "−", "⌖"].map(c => (
              <button key={c} style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(17,24,39,0.85)", backdropFilter: "blur(8px)", border: `1px solid ${C.border}`, color: C.textMuted, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>{c}</button>
            ))}
          </div>
          {/* Legend */}
          <Glass style={{ position: "absolute", bottom: 16, left: 16, padding: "8px 14px", display: "flex", gap: 12, alignItems: "center" }}>
            {["Excellent", "Good", "Fair", "Poor", "V.Poor"].map((l, i) => (
              <span key={l} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textDim }}>
                <span style={{ width: 10, height: 3, borderRadius: 2, background: qualityColors[i] }} />{l}
              </span>
            ))}
          </Glass>
        </SimMap>

        {/* Segment sidebar */}
        {sidebar && (
          <div style={{ width: 280, borderLeft: `1px solid ${C.border}`, background: C.bg, overflowY: "auto", flexShrink: 0 }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>Road Preview Cards</div>
              <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>{SEGMENTS.length} segments • 57.4 km total</div>
            </div>
            {SEGMENTS.map((seg, i) => (
              <div key={i} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", transition: "background 0.15s" }}
                onMouseEnter={(e) => e.currentTarget.style.background = C.surfaceHover}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{seg.name}</div>
                  <QBadge score={seg.quality} />
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 10, color: C.textDim, alignItems: "center" }}>
                  <span>{seg.km} km</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Curves <CurvBar value={seg.curviness} /></span>
                  <span>{seg.elevation}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6, fontSize: 10 }}>
                  <span style={{ color: C.textDim }}>{seg.surface}</span>
                  {seg.hazards > 0 && <span style={{ color: C.poor }}>⚠ {seg.hazards} hazard{seg.hazards > 1 ? "s" : ""}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timeline strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: `1px solid ${C.border}`, background: C.bg, flexShrink: 0, overflowX: "auto" }}>
        {[
          { day: 1, km: 245, stops: "Čeladná → Bílá" },
          { day: 2, km: 268, stops: "Bílá → Rožnov" },
          { day: 3, km: 192, stops: "Rožnov → Ostrava" },
        ].map((d) => (
          <button key={d.day} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 10, border: `1px solid ${d.day === 1 ? C.cyan + "40" : C.border}`, background: d.day === 1 ? C.cyan + "08" : C.surface, cursor: "pointer", color: C.text, fontFamily: "inherit", whiteSpace: "nowrap" }}>
            <span style={{ fontWeight: 700, fontSize: 12, color: d.day === 1 ? C.cyan : C.text }}>Day {d.day}</span>
            <span style={{ fontSize: 10, color: C.textDim }}>{d.km} km</span>
            <span style={{ fontSize: 10, color: C.textDim }}>• {d.stops}</span>
          </button>
        ))}
        <button style={{ padding: "8px 14px", borderRadius: 10, border: `1px dashed ${C.borderLight}`, background: "none", color: C.textDim, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>+ Add day</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ROAD QUALITY EXPLORER
// ═══════════════════════════════════════════
function ExplorerPage({ filter, setFilter }) {
  const qOpts = [
    { label: "Excellent", color: C.excellent },
    { label: "Good", color: C.good },
    { label: "Fair", color: C.fair },
    { label: "Poor", color: C.poor },
    { label: "Very Poor", color: C.veryPoor },
  ];
  const sOpts = [
    { label: "Asphalt", color: "#3B82F6" },
    { label: "Concrete", color: "#6B7280" },
    { label: "Cobblestone", color: "#A78BFA" },
    { label: "Gravel", color: "#D97706" },
    { label: "Dirt", color: "#92400E" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Search bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <input placeholder="Search roads, regions..." style={{ flex: 1, maxWidth: 300, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 12, fontFamily: "inherit" }} />
        <Btn icon={Icons.filter} label="Filters" active={filter} onClick={() => setFilter(!filter)} />
        <Btn label="Quality" active />
        <Btn label="Hazards" active />
        <Btn label="Surface" />
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Filter panel */}
        {filter && (
          <div style={{ width: 220, borderRight: `1px solid ${C.border}`, background: C.bg, padding: 16, overflowY: "auto", flexShrink: 0 }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: C.textDim, marginBottom: 10 }}>Road quality</div>
              {qOpts.map((o) => (
                <label key={o.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textMuted, marginBottom: 6, cursor: "pointer" }}>
                  <input type="checkbox" defaultChecked style={{ accentColor: C.cyan }} />
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: o.color }} />
                  {o.label}
                </label>
              ))}
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: C.textDim, marginBottom: 10 }}>Surface type</div>
              {sOpts.map((o) => (
                <label key={o.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textMuted, marginBottom: 6, cursor: "pointer" }}>
                  <input type="checkbox" defaultChecked style={{ accentColor: C.cyan }} />
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: o.color }} />
                  {o.label}
                </label>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: C.textDim, marginBottom: 10 }}>Curviness</div>
              <input type="range" min={0} max={100} defaultValue={0} style={{ width: "100%", accentColor: C.cyan }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.textDim, marginTop: 2 }}>
                <span>Straight</span><span>Very twisty</span>
              </div>
            </div>
          </div>
        )}

        {/* Map with segment detail */}
        <SimMap>
          {/* Segment detail panel */}
          <Glass style={{ position: "absolute", top: 16, right: 16, width: 260, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>Čeladná → Kunčice</span>
                <QBadge score={4.8} size="lg" />
              </div>
              <div style={{ fontSize: 11, color: C.textDim }}>12.4 km • Asphalt • 340m elevation</div>
            </div>
            <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <MiniStat label="Confidence" value="High" color={C.excellent} />
              <MiniStat label="Rider passes" value="47" color={C.cyan} />
              <MiniStat label="Last updated" value="2d ago" color={C.textMuted} />
              <MiniStat label="Curviness" value="82/100" color={C.cyan} />
            </div>
            <div style={{ padding: "0 16px 12px" }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 6, fontWeight: 600 }}>Quality trend (6 months)</div>
              <div style={{ height: 50 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={[{ m: "N", s: 4.2 }, { m: "D", s: 4.0 }, { m: "J", s: 3.8 }, { m: "F", s: 4.1 }, { m: "M", s: 4.5 }, { m: "A", s: 4.8 }]}>
                    <Line type="monotone" dataKey="s" stroke={C.cyan} strokeWidth={2} dot={{ r: 2, fill: C.cyan }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{ padding: "8px 16px 14px", borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 6, fontWeight: 600 }}>Active hazards (0)</div>
              <div style={{ fontSize: 11, color: C.textDim }}>No active hazards on this segment ✓</div>
            </div>
          </Glass>

          {/* Active hazards panel */}
          <Glass style={{ position: "absolute", bottom: 16, right: 16, width: 260, padding: "12px 0" }}>
            <div style={{ padding: "0 14px 8px", fontSize: 11, fontWeight: 700, color: C.textMuted, display: "flex", justifyContent: "space-between" }}>
              <span>Active hazards</span><span style={{ color: C.textDim }}>{HAZARDS.length}</span>
            </div>
            {HAZARDS.map((h, i) => (
              <div key={i} style={{ padding: "6px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <span style={{ fontSize: 14 }}>{hazardEmoji[h.type]}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{h.type}</div>
                  <div style={{ fontSize: 9, color: C.textDim }}>{h.location} • {h.time}</div>
                </div>
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: severityColor[h.severity] + "18", color: severityColor[h.severity], fontWeight: 700 }}>{h.severity}</span>
              </div>
            ))}
          </Glass>
        </SimMap>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// RIDE LIST
// ═══════════════════════════════════════════
function RideListPage({ onSelect }) {
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {RIDES.map((r) => {
          const avgQ = Object.entries(r.quality).reduce((a, [k, v]) => a + ({ excellent: 5, good: 4, fair: 3, poor: 2, veryPoor: 1 }[k] || 3) * v, 0) / 100;
          return (
            <div key={r.id} onClick={() => onSelect(r)}
              style={{ display: "flex", alignItems: "center", padding: "14px 18px", borderRadius: 14, background: C.surface, border: `1px solid ${C.border}`, cursor: "pointer", transition: "all 0.15s" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.borderLight; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginTop: 3, display: "flex", gap: 14 }}>
                  <span>{r.date}</span><span>{r.km} km</span><span>{r.duration}</span><span>{r.avgSpeed} km/h avg</span>
                </div>
              </div>
              <QBadge score={avgQ} />
              <Icon d={Icons.chevRight} size={16} color={C.textDim} style={{ marginLeft: 12 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// RIDE DETAIL
// ═══════════════════════════════════════════
function RideDetailPage({ ride, onBack }) {
  const pieData = Object.entries(ride.quality).map(([k, v], i) => ({ name: k, value: v }));

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: C.textDim, cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginBottom: 16, fontWeight: 600 }}>
        <Icon d={Icons.chevLeft} size={14} /> Back to rides
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{ride.name}</h1>
          <span style={{ fontSize: 12, color: C.textDim }}>{ride.date}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn icon={Icons.share} label="Share" />
          <Btn icon={Icons.download} label="GPX" />
        </div>
      </div>

      {/* Map */}
      <SimMap style={{ height: 220, borderRadius: 16, marginBottom: 20, border: `1px solid ${C.border}` }} />

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { label: "Distance", value: `${ride.km}`, unit: "km" },
          { label: "Duration", value: ride.duration, unit: "" },
          { label: "Avg Speed", value: `${ride.avgSpeed}`, unit: "km/h" },
          { label: "Max Speed", value: `${ride.maxSpeed}`, unit: "km/h" },
          { label: "Elevation", value: `${ride.elevation}`, unit: "m" },
        ].map((s) => (
          <div key={s.label} style={{ padding: "14px 16px", borderRadius: 12, background: C.surface, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{s.value} <span style={{ fontSize: 11, fontWeight: 500, color: C.textDim }}>{s.unit}</span></div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        {/* Elevation */}
        <div style={{ padding: 16, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 10 }}>Elevation profile</div>
          <div style={{ height: 100 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ELEVATION_DATA}>
                <Area type="monotone" dataKey="e" stroke={C.cyan} fill={C.cyan + "18"} strokeWidth={1.5} />
                <XAxis dataKey="d" hide />
                <YAxis hide />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Speed */}
        <div style={{ padding: 16, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 10 }}>Speed over time</div>
          <div style={{ height: 100 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={SPEED_DATA}>
                <Line type="monotone" dataKey="s" stroke="#A78BFA" strokeWidth={1.5} dot={false} />
                <XAxis dataKey="t" hide />
                <YAxis hide />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Quality breakdown */}
        <div style={{ padding: 16, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 10 }}>Road quality breakdown</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 80, height: 80 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} innerRadius={22} outerRadius={36} dataKey="value" stroke="none">
                    {pieData.map((_, i) => <Cell key={i} fill={qualityColors[i]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {pieData.map((d, i) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: qualityColors[i] }} />
                  <span style={{ color: C.textDim, width: 50 }}>{qualityLabel[i]}</span>
                  <span style={{ fontWeight: 700, color: C.textMuted }}>{d.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// STATS PAGE
// ═══════════════════════════════════════════
function StatsPage() {
  const totals = [
    { label: "Total distance", value: "2,847", unit: "km" },
    { label: "Total rides", value: "43", unit: "" },
    { label: "Total hours", value: "68", unit: "h" },
    { label: "Elevation gained", value: "34,200", unit: "m" },
    { label: "Roads discovered", value: "312", unit: "" },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 24 }}>
        {totals.map((s) => (
          <div key={s.label} style={{ padding: "14px 16px", borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{s.value}<span style={{ fontSize: 11, fontWeight: 500, color: C.textDim, marginLeft: 3 }}>{s.unit}</span></div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ padding: 20, borderRadius: 16, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Monthly distance</div>
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={MONTHLY_STATS} barSize={24}>
                <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, color: C.text }} />
                <Bar dataKey="km" fill={C.cyan} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ padding: 20, borderRadius: 16, background: C.surface, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Road quality encountered</div>
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[
                { month: "Nov", excellent: 30, good: 35, fair: 20, poor: 10, vPoor: 5 },
                { month: "Dec", excellent: 25, good: 30, fair: 25, poor: 12, vPoor: 8 },
                { month: "Jan", excellent: 15, good: 25, fair: 30, poor: 18, vPoor: 12 },
                { month: "Feb", excellent: 20, good: 30, fair: 28, poor: 14, vPoor: 8 },
                { month: "Mar", excellent: 35, good: 35, fair: 18, poor: 8, vPoor: 4 },
                { month: "Apr", excellent: 40, good: 35, fair: 15, poor: 7, vPoor: 3 },
              ]} barSize={18}>
                <XAxis dataKey="month" tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.textDim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Bar dataKey="excellent" stackId="q" fill={C.excellent} />
                <Bar dataKey="good" stackId="q" fill={C.good} />
                <Bar dataKey="fair" stackId="q" fill={C.fair} />
                <Bar dataKey="poor" stackId="q" fill={C.poor} />
                <Bar dataKey="vPoor" stackId="q" fill={C.veryPoor} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// COMMUNITY (placeholder)
// ═══════════════════════════════════════════
function CommunityPage() {
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input placeholder="Search routes, riders, regions..." style={{ flex: 1, maxWidth: 340, padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 12, fontFamily: "inherit" }} />
        {["Popular", "Newest", "Nearest"].map((l, i) => (
          <button key={l} style={{ padding: "8px 14px", borderRadius: 10, border: "none", background: i === 0 ? C.cyan + "14" : "transparent", color: i === 0 ? C.cyan : C.textDim, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>
      <div style={{ borderRadius: 20, background: C.surface, border: `1px solid ${C.border}`, padding: 48, textAlign: "center" }}>
        <Icon d={Icons.users} size={48} color={C.textDim} style={{ margin: "0 auto 16px", display: "block" }} />
        <p style={{ color: C.textMuted, fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Community is growing</p>
        <p style={{ color: C.textDim, fontSize: 12 }}>Shared routes and rides from the community will appear here.</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// SETTINGS (placeholder)
// ═══════════════════════════════════════════
function SettingsPage() {
  const sections = [
    { icon: Icons.home, label: "Profile", desc: "Display name, avatar, home region" },
    { icon: Icons.chart, label: "Subscription", desc: "Free plan — upgrade for unlimited trips" },
    { icon: Icons.layers, label: "Privacy", desc: "Visibility, data sharing, consent" },
    { icon: Icons.bike, label: "My Bikes", desc: "Manage your motorcycle garage" },
    { icon: Icons.bell, label: "Notifications", desc: "Email, alerts, community updates" },
  ];
  return (
    <div style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sections.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 14, cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={(e) => e.currentTarget.style.background = C.surface}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon d={s.icon} size={16} color={C.textDim} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: C.textDim }}>{s.desc}</div>
            </div>
            <Icon d={Icons.chevRight} size={14} color={C.textDim} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared small components ──
function Btn({ icon, label, primary, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
      background: primary ? C.cyan : active ? C.cyan + "14" : C.surface,
      color: primary ? C.bg : active ? C.cyan : C.textMuted,
      fontSize: 11, fontWeight: 600, fontFamily: "inherit", transition: "all 0.15s", whiteSpace: "nowrap",
    }}>
      {icon && <Icon d={icon} size={13} />}
      {label}
    </button>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: C.textDim, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
