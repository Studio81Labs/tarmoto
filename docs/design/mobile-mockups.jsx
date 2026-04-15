import { useState, useEffect, useCallback, useRef } from "react";

// ── Theme ──
const C = {
  bg: "#070A10", card: "#0C1018", surface: "#111827", elevated: "#1A2235",
  cyan: "#0ED3CF", cyanDark: "#0A9E9B", cyanAlpha: "rgba(14,211,207,0.12)",
  text: "#E8ECF2", text2: "#8B95A8", text3: "#4A5568",
  border: "rgba(255,255,255,0.06)", borderLight: "rgba(255,255,255,0.12)",
  excellent: "#22C55E", good: "#84CC16", fair: "#EAB308", poor: "#F97316", veryPoor: "#EF4444",
  danger: "#EF4444", dangerAlpha: "rgba(239,68,68,0.12)",
};

const qualityColor = (s) => s >= 4.5 ? C.excellent : s >= 3.5 ? C.good : s >= 2.5 ? C.fair : s >= 1.5 ? C.poor : C.veryPoor;
const qualityLabel = (s) => s >= 4.5 ? "Excellent" : s >= 3.5 ? "Good" : s >= 2.5 ? "Fair" : s >= 1.5 ? "Poor" : "Very poor";

// ── Simulated Map Background ──
function MapBG({ landscape, quality = 4.2, showRoads = true }) {
  const w = landscape ? 900 : 420;
  const h = landscape ? 420 : 700;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0 }}>
      <rect width={w} height={h} fill="#0a1628" />
      {/* Grid */}
      {Array.from({ length: 30 }).map((_, i) => (
        <line key={`h${i}`} x1={0} y1={i * 30} x2={w} y2={i * 30} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
      ))}
      {Array.from({ length: 30 }).map((_, i) => (
        <line key={`v${i}`} x1={i * 30} y1={0} x2={i * 30} y2={h} stroke="rgba(255,255,255,0.02)" strokeWidth="1" />
      ))}
      {showRoads && <>
        {/* Roads with quality colors */}
        <path d={`M ${w*0.1} ${h*0.8} Q ${w*0.3} ${h*0.6} ${w*0.4} ${h*0.45} T ${w*0.55} ${h*0.25} T ${w*0.7} ${h*0.12}`} stroke={C.excellent} strokeWidth="6" fill="none" opacity="0.6" strokeLinecap="round" />
        <path d={`M ${w*0.05} ${h*0.65} Q ${w*0.2} ${h*0.55} ${w*0.35} ${h*0.58} T ${w*0.6} ${h*0.48}`} stroke={C.good} strokeWidth="5" fill="none" opacity="0.5" strokeLinecap="round" />
        <path d={`M ${w*0.25} ${h*0.9} Q ${w*0.4} ${h*0.75} ${w*0.55} ${h*0.72} T ${w*0.8} ${h*0.6}`} stroke={C.fair} strokeWidth="4" fill="none" opacity="0.5" strokeLinecap="round" />
        <path d={`M ${w*0.6} ${h*0.85} Q ${w*0.7} ${h*0.7} ${w*0.75} ${h*0.55}`} stroke={C.poor} strokeWidth="4" fill="none" opacity="0.4" strokeLinecap="round" />
        <path d={`M ${w*0.3} ${h*0.4} L ${w*0.5} ${h*0.35} L ${w*0.65} ${h*0.4}`} stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="none" strokeLinecap="round" />
        {/* Rider position */}
        <circle cx={w * 0.4} cy={h * 0.45} r="8" fill={C.cyan} opacity="0.9" />
        <circle cx={w * 0.4} cy={h * 0.45} r="18" fill={C.cyan} opacity="0.15" />
        <circle cx={w * 0.4} cy={h * 0.45} r="30" fill={C.cyan} opacity="0.06" />
        {/* Direction indicator */}
        <polygon points={`${w*0.4-5},${h*0.45+2} ${w*0.4+5},${h*0.45+2} ${w*0.4},${h*0.45-10}`} fill={C.cyan} opacity="0.8" />
        {/* Hazard marker */}
        <g transform={`translate(${w*0.52},${h*0.3})`}>
          <circle r="10" fill="rgba(234,179,8,0.3)" stroke={C.fair} strokeWidth="1.5" />
          <text textAnchor="middle" y="4" fill={C.fair} fontSize="12" fontWeight="bold">!</text>
        </g>
      </>}
    </svg>
  );
}

// ── Tab Bar ──
function TabBar({ active, onTab, landscape }) {
  const tabs = [
    { id: "home", icon: "⌂", label: "Home" },
    { id: "map", icon: "◎", label: "Map" },
    { id: "ride", icon: "▶", label: "Ride" },
    { id: "trips", icon: "☰", label: "Trips" },
    { id: "profile", icon: "◉", label: "Profile" },
  ];

  if (landscape) {
    return (
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 56, background: "rgba(12,16,24,0.95)", borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, padding: "8px 0", zIndex: 50 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => onTab(t.id)} style={{ background: "none", border: "none", padding: "10px 0", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: 18, color: active === t.id ? C.cyan : C.text3, filter: active === t.id ? `drop-shadow(0 0 4px ${C.cyan})` : "none" }}>{t.icon}</span>
            <span style={{ fontSize: 8, fontWeight: active === t.id ? 700 : 500, color: active === t.id ? C.cyan : C.text3 }}>{t.label}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(12,16,24,0.95)", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0 12px", zIndex: 50 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onTab(t.id)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 12px" }}>
          <span style={{ fontSize: 20, color: active === t.id ? C.cyan : C.text3, filter: active === t.id ? `drop-shadow(0 0 4px ${C.cyan})` : "none" }}>{t.icon}</span>
          <span style={{ fontSize: 9, fontWeight: active === t.id ? 700 : 500, color: active === t.id ? C.cyan : C.text3 }}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── HOME SCREEN ──
function HomeScreen({ landscape, onNavigate }) {
  const ml = landscape ? 56 : 0;
  return (
    <div style={{ padding: `20px 20px ${landscape ? 20 : 70}px`, marginLeft: ml, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <p style={{ color: C.text3, fontSize: 12 }}>Good morning</p>
          <p style={{ color: C.text, fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em" }}>Rider</p>
        </div>
        <div style={{ width: 36, height: 36, borderRadius: 12, background: `linear-gradient(135deg, ${C.cyan}, ${C.cyanDark})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🔔</div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => onNavigate("ride-active")} style={{ flex: 1, background: `linear-gradient(135deg, ${C.cyan}, ${C.cyanDark})`, border: "none", borderRadius: 16, padding: "18px 14px", cursor: "pointer", textAlign: "left" }}>
          <div style={{ fontSize: 22, marginBottom: 4 }}>▶️</div>
          <p style={{ fontWeight: 800, fontSize: 14, color: C.bg, margin: 0 }}>Start Ride</p>
          <p style={{ fontSize: 10, color: "rgba(0,0,0,0.5)", margin: "4px 0 0" }}>Free ride or navigate</p>
        </button>
        <button onClick={() => onNavigate("commute")} style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "18px 14px", cursor: "pointer", textAlign: "left" }}>
          <div style={{ fontSize: 22, marginBottom: 4 }}>🏢</div>
          <p style={{ fontWeight: 800, fontSize: 14, color: C.text, margin: 0 }}>Commute</p>
          <p style={{ fontSize: 10, color: C.text3, margin: "4px 0 0" }}>Home → Work · 12 km</p>
        </button>
      </div>

      <div style={{ marginTop: 20 }}>
        <p style={{ color: C.text2, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 8 }}>ACTIVE HAZARDS</p>
        {[
          { icon: "⚠️", text: "Gravel on D35 near Ostrava", time: "12 min ago", dist: "3.2 km" },
          { icon: "🚧", text: "Roadworks on E462", time: "2h ago", dist: "8.1 km" },
        ].map((h, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, borderRadius: 12, padding: "10px 12px", marginBottom: 6, border: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 18 }}>{h.icon}</span>
            <div style={{ flex: 1 }}>
              <p style={{ color: C.text, fontSize: 12, fontWeight: 600, margin: 0 }}>{h.text}</p>
              <p style={{ color: C.text3, fontSize: 10, margin: "2px 0 0" }}>{h.time} · {h.dist}</p>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <p style={{ color: C.text2, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 8 }}>RECENT RIDES</p>
        {[
          { name: "Morning Commute", dist: "12.3 km", dur: "18 min", q: 4.2 },
          { name: "Beskydy Loop", dist: "142 km", dur: "2h 34m", q: 4.7 },
        ].map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.card, borderRadius: 12, padding: "10px 12px", marginBottom: 6, border: `1px solid ${C.border}`, cursor: "pointer" }}>
            <div>
              <p style={{ color: C.text, fontSize: 12, fontWeight: 600, margin: 0 }}>{r.name}</p>
              <p style={{ color: C.text3, fontSize: 10, margin: "2px 0 0" }}>{r.dist} · {r.dur}</p>
            </div>
            <div style={{ background: qualityColor(r.q) + "22", color: qualityColor(r.q), fontSize: 13, fontWeight: 800, padding: "4px 10px", borderRadius: 8 }}>{r.q}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RIDE ACTIVE SCREEN (Full-screen map, Calimoto-style) ──
function RideActiveScreen({ landscape, onExit }) {
  const [hudVisible, setHudVisible] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  const hideTimer = useRef(null);

  const resetHideTimer = useCallback(() => {
    setHudVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHudVisible(false), 5000);
  }, []);

  useEffect(() => {
    resetHideTimer();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  const qScore = 4.6;
  const qColor = qualityColor(qScore);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#0a1628" }}
      onClick={resetHideTimer}>
      {/* Full-screen map */}
      <MapBG landscape={landscape} quality={qScore} />

      {/* HUD - only shows when hudVisible, auto-hides */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", transition: "opacity 0.4s", opacity: hudVisible ? 1 : 0 }}>

        {/* Top: Next turn + Speed */}
        <div style={{ position: "absolute", top: landscape ? 12 : 16, left: landscape ? 12 : 16, right: landscape ? 12 : 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start", pointerEvents: "auto" }}>
          {/* Next turn card */}
          <div style={{ background: "rgba(12,16,24,0.85)", backdropFilter: "blur(12px)", borderRadius: 14, padding: landscape ? "8px 14px" : "10px 14px", border: `1px solid ${C.border}`, maxWidth: landscape ? 260 : "65%" }}>
            <p style={{ color: C.cyan, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>NEXT TURN</p>
            <p style={{ color: C.text, fontSize: landscape ? 14 : 16, fontWeight: 800, margin: "2px 0 0" }}>↗️ Right in 340m</p>
            <p style={{ color: C.text3, fontSize: 10, margin: "2px 0 0" }}>onto Hlavní třída</p>
          </div>

          {/* Speed bubble */}
          <div style={{ background: "rgba(12,16,24,0.85)", backdropFilter: "blur(12px)", borderRadius: 14, padding: landscape ? "6px 14px" : "8px 14px", border: `1px solid ${C.border}`, textAlign: "center", minWidth: landscape ? 56 : 64 }}>
            <p style={{ color: C.text3, fontSize: 8, fontWeight: 700, margin: 0 }}>KM/H</p>
            <p style={{ color: C.text, fontSize: landscape ? 24 : 30, fontWeight: 900, margin: 0, letterSpacing: "-0.04em" }}>72</p>
          </div>
        </div>

        {/* Road quality indicator strip (always visible, minimal) */}
        <div style={{ position: "absolute", top: landscape ? 68 : 90, left: landscape ? 12 : 16, right: landscape ? 12 : 16, pointerEvents: "auto" }}>
          <div style={{ background: qColor + "18", border: `1px solid ${qColor}40`, borderRadius: 10, padding: "6px 12px", display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: qColor, boxShadow: `0 0 6px ${qColor}` }} />
            <span style={{ color: qColor, fontSize: 11, fontWeight: 700 }}>Road: {qualityLabel(qScore)}</span>
            <span style={{ color: qColor + "88", fontSize: 10, marginLeft: "auto" }}>{qScore} ★</span>
          </div>
        </div>

        {/* Hazard warning (floating, mid-screen) */}
        <div style={{ position: "absolute", bottom: landscape ? 60 : 160, left: landscape ? 12 : 16, right: landscape ? 12 : 16, pointerEvents: "auto" }}>
          <div style={{ background: "rgba(234,179,8,0.1)", border: `1px solid rgba(234,179,8,0.25)`, borderRadius: 12, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <div>
              <p style={{ color: C.fair, fontSize: 11, fontWeight: 700, margin: 0 }}>Gravel ahead in 1.2 km</p>
              <p style={{ color: "rgba(234,179,8,0.5)", fontSize: 9, margin: "1px 0 0" }}>Reported 8 min ago</p>
            </div>
          </div>
        </div>

        {/* Bottom controls */}
        <div style={{ position: "absolute", bottom: landscape ? 12 : 16, left: landscape ? 12 : 16, right: landscape ? 12 : 16, display: "flex", gap: 8, pointerEvents: "auto" }}>
          {/* Stats toggle */}
          <button onClick={(e) => { e.stopPropagation(); setStatsOpen(!statsOpen); }} style={{ flex: 1, background: "rgba(12,16,24,0.85)", backdropFilter: "blur(12px)", border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px", cursor: "pointer", display: "flex", justifyContent: "space-around" }}>
            {[
              { label: "DIST", value: "23.4", unit: "km" },
              { label: "TIME", value: "0:34", unit: "" },
              { label: "ELEV", value: "+420", unit: "m" },
              ...(!landscape ? [{ label: "AVG Q", value: "4.3", unit: "★" }] : []),
            ].map((s, i) => (
              <div key={i} style={{ textAlign: "center" }}>
                <p style={{ color: C.text3, fontSize: 7, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>{s.label}</p>
                <p style={{ color: C.text, fontSize: 14, fontWeight: 800, margin: "2px 0 0" }}>{s.value}</p>
              </div>
            ))}
          </button>

          {/* Hazard report FAB */}
          <button onClick={(e) => { e.stopPropagation(); }} style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(234,179,8,0.15)", border: `1px solid rgba(234,179,8,0.3)`, color: C.fair, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>⚠️</button>

          {/* End ride */}
          <button onClick={(e) => { e.stopPropagation(); onExit(); }} style={{ width: 48, height: 48, borderRadius: 14, background: C.dangerAlpha, border: `1px solid rgba(239,68,68,0.3)`, color: C.danger, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>⏹</button>
        </div>
      </div>

      {/* Tap hint */}
      {!hudVisible && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "rgba(12,16,24,0.6)", borderRadius: 20, padding: "6px 16px" }}>
          <p style={{ color: C.text3, fontSize: 10, margin: 0 }}>Tap to show controls</p>
        </div>
      )}

      {/* Stats panel (slides up) */}
      {statsOpen && (
        <div style={{ position: "absolute", bottom: landscape ? 65 : 72, left: landscape ? 12 : 16, right: landscape ? 12 : 16, background: "rgba(12,16,24,0.92)", backdropFilter: "blur(16px)", borderRadius: 16, padding: 16, border: `1px solid ${C.border}`, zIndex: 10 }}
          onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "grid", gridTemplateColumns: landscape ? "repeat(6, 1fr)" : "repeat(3, 1fr)", gap: 10 }}>
            {[
              { label: "DISTANCE", value: "23.4 km" },
              { label: "DURATION", value: "0:34:12" },
              { label: "AVG SPEED", value: "52 km/h" },
              { label: "MAX SPEED", value: "94 km/h" },
              { label: "ELEVATION", value: "+420m" },
              { label: "AVG QUALITY", value: "4.3 ★" },
              { label: "LEAN MAX", value: "32°" },
              { label: "CURVES", value: "47" },
              { label: "SEGMENTS", value: "234" },
            ].map((s, i) => (
              <div key={i} style={{ textAlign: "center", padding: 6 }}>
                <p style={{ color: C.text3, fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", margin: 0 }}>{s.label}</p>
                <p style={{ color: C.text, fontSize: 15, fontWeight: 800, margin: "4px 0 0" }}>{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── MAP SCREEN ──
function MapScreen({ landscape }) {
  const ml = landscape ? 56 : 0;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MapBG landscape={landscape} />
      {/* Search bar */}
      <div style={{ position: "absolute", top: 14, left: ml + 14, right: 14, zIndex: 10 }}>
        <div style={{ background: "rgba(12,16,24,0.9)", backdropFilter: "blur(12px)", borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, border: `1px solid ${C.border}` }}>
          <span style={{ color: C.text3 }}>🔍</span>
          <span style={{ color: C.text3, fontSize: 13 }}>Search road or area...</span>
        </div>
      </div>
      {/* Layer filters */}
      <div style={{ position: "absolute", top: 62, left: ml + 14, display: "flex", gap: 6, zIndex: 10 }}>
        {[{ l: "Quality", active: true }, { l: "Surface" }, { l: "Hazards" }].map((f, i) => (
          <div key={i} style={{ background: f.active ? C.cyanAlpha : "rgba(12,16,24,0.8)", border: `1px solid ${f.active ? "rgba(14,211,207,0.3)" : C.border}`, borderRadius: 18, padding: "4px 12px" }}>
            <span style={{ color: f.active ? C.cyan : C.text2, fontSize: 11, fontWeight: f.active ? 700 : 500 }}>{f.l}</span>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div style={{ position: "absolute", bottom: landscape ? 14 : 70, left: ml + 14, background: "rgba(12,16,24,0.9)", backdropFilter: "blur(10px)", borderRadius: 12, padding: "10px 14px", border: `1px solid ${C.border}`, zIndex: 10 }}>
        <p style={{ color: C.text2, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 6px" }}>ROAD QUALITY</p>
        {[
          { c: C.excellent, l: "Excellent" }, { c: C.good, l: "Good" },
          { c: C.fair, l: "Fair" }, { c: C.poor, l: "Poor" },
        ].map((q, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div style={{ width: 18, height: 3, background: q.c, borderRadius: 2 }} />
            <span style={{ color: C.text2, fontSize: 9 }}>{q.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── TRIPS SCREEN ──
function TripsScreen({ landscape }) {
  const ml = landscape ? 56 : 0;
  return (
    <div style={{ padding: `20px 20px ${landscape ? 20 : 70}px`, marginLeft: ml, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <p style={{ color: C.text, fontSize: 20, fontWeight: 800, margin: 0 }}>My Trips</p>
        <div style={{ background: C.cyanAlpha, border: `1px solid rgba(14,211,207,0.25)`, borderRadius: 10, padding: "6px 12px", color: C.cyan, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>+ New Trip</div>
      </div>
      {[
        { title: "Beskydy Weekend", days: 3, region: "Beskydy & Jeseníky", status: "planned", riders: 4, q: 4.5 },
        { title: "Alps Summer Tour", days: 7, region: "Austria / Italy", status: "draft", riders: 2, q: null },
        { title: "Šumava Loop", days: 2, region: "South Bohemia", status: "completed", riders: 3, q: 4.2 },
      ].map((t, i) => (
        <div key={i} style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 12, border: `1px solid ${C.border}`, cursor: "pointer" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <p style={{ color: C.text, fontSize: 16, fontWeight: 700, margin: 0 }}>{t.title}</p>
              <p style={{ color: C.text3, fontSize: 11, margin: "4px 0 0" }}>{t.region} · {t.days} days · {t.riders} riders</p>
            </div>
            {t.q && <div style={{ background: qualityColor(t.q) + "22", color: qualityColor(t.q), fontWeight: 800, fontSize: 14, padding: "4px 10px", borderRadius: 8 }}>{t.q}</div>}
          </div>
          <div style={{ marginTop: 10 }}>
            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: t.status === "completed" ? "rgba(34,197,94,0.12)" : t.status === "planned" ? C.cyanAlpha : "rgba(75,85,99,0.2)", color: t.status === "completed" ? C.excellent : t.status === "planned" ? C.cyan : C.text3 }}>{t.status.toUpperCase()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── PROFILE SCREEN ──
function ProfileScreen({ landscape }) {
  const ml = landscape ? 56 : 0;
  return (
    <div style={{ padding: `20px 20px ${landscape ? 20 : 70}px`, marginLeft: ml, overflowY: "auto", height: "100%" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ width: 72, height: 72, borderRadius: 22, background: `linear-gradient(135deg, ${C.cyan}, ${C.cyanDark})`, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: C.bg, fontWeight: 900 }}>M</div>
        <p style={{ color: C.text, fontSize: 20, fontWeight: 800, margin: 0 }}>Martin</p>
        <p style={{ color: C.text3, fontSize: 12, margin: "4px 0 0" }}>Rider since April 2026</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { label: "Total km", value: "2,340" },
          { label: "Rides", value: "47" },
          { label: "Roads rated", value: "156" },
        ].map((s, i) => (
          <div key={i} style={{ background: C.card, borderRadius: 12, padding: 12, textAlign: "center", border: `1px solid ${C.border}` }}>
            <p style={{ color: C.text, fontSize: 18, fontWeight: 800, margin: 0 }}>{s.value}</p>
            <p style={{ color: C.text3, fontSize: 10, margin: "4px 0 0" }}>{s.label}</p>
          </div>
        ))}
      </div>
      {["Settings", "Emergency Contacts", "My Bikes", "Export Data", "Help & Feedback", "About Tarmoto"].map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
          <span style={{ color: C.text, fontSize: 14 }}>{item}</span>
          <span style={{ color: C.text3, fontSize: 14 }}>›</span>
        </div>
      ))}
    </div>
  );
}

// ── MAIN APP ──
export default function TarmotoMock() {
  const [orientation, setOrientation] = useState("portrait");
  const [activeTab, setActiveTab] = useState("home");
  const [rideActive, setRideActive] = useState(false);

  const landscape = orientation === "landscape";
  const phoneW = landscape ? 812 : 390;
  const phoneH = landscape ? 390 : 812;

  const handleTab = (tab) => {
    if (tab === "ride") {
      setRideActive(true);
    } else {
      setActiveTab(tab);
      setRideActive(false);
    }
  };

  const handleNavigate = (target) => {
    if (target === "ride-active") setRideActive(true);
    if (target === "commute") { setActiveTab("home"); }
  };

  const renderScreen = () => {
    if (rideActive) return <RideActiveScreen landscape={landscape} onExit={() => setRideActive(false)} />;
    switch (activeTab) {
      case "home": return <HomeScreen landscape={landscape} onNavigate={handleNavigate} />;
      case "map": return <MapScreen landscape={landscape} />;
      case "trips": return <TripsScreen landscape={landscape} />;
      case "profile": return <ProfileScreen landscape={landscape} />;
      default: return <HomeScreen landscape={landscape} onNavigate={handleNavigate} />;
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#050810", fontFamily: "'Outfit', sans-serif", padding: "24px 16px 40px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ marginBottom: 20, textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
          <svg width="24" height="24" viewBox="0 0 100 100" fill="none">
            <rect x="18" y="20" width="64" height="12" rx="4" fill="#0ED3CF" />
            <rect x="40" y="20" width="20" height="42" rx="4" fill="#0ED3CF" />
            <path d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76" stroke="#0ED3CF" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span style={{ fontSize: 18, fontWeight: 900, color: "#0ED3CF", letterSpacing: "-0.03em" }}>TARMOTO</span>
        </div>
        <p style={{ color: "#4A5568", fontSize: 11 }}>Interactive App Mockup · Tap to navigate</p>
      </div>

      {/* Orientation toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {["portrait", "landscape"].map(o => (
          <button key={o} onClick={() => setOrientation(o)} style={{
            padding: "8px 20px", borderRadius: 10,
            background: orientation === o ? C.cyanAlpha : "rgba(30,41,59,0.4)",
            border: `1px solid ${orientation === o ? "rgba(14,211,207,0.3)" : "rgba(255,255,255,0.06)"}`,
            color: orientation === o ? C.cyan : C.text3,
            fontSize: 13, fontWeight: orientation === o ? 700 : 500,
            cursor: "pointer", fontFamily: "'Outfit', sans-serif",
            textTransform: "capitalize",
          }}>{o === "portrait" ? "📱 Portrait" : "📱 Landscape"}</button>
        ))}
        {rideActive && (
          <span style={{ padding: "8px 14px", borderRadius: 10, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.25)", color: C.excellent, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.excellent, animation: "pulse 1.5s infinite" }} />
            RIDE MODE
          </span>
        )}
      </div>

      {/* Phone frame */}
      <div style={{
        width: phoneW, maxWidth: "100%",
        transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
        <div style={{
          background: "#1a1a2e",
          borderRadius: landscape ? 24 : 40,
          padding: landscape ? "8px" : "10px 10px 12px",
          boxShadow: "0 25px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)",
          transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
        }}>
          {/* Status bar */}
          {!rideActive && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: landscape ? "4px 16px 2px" : "4px 20px 2px", color: C.text3, fontSize: 10, fontWeight: 600 }}>
              <span>9:41</span>
              {!landscape && <div style={{ width: 70, height: 20, background: "#000", borderRadius: 10 }} />}
              <span>⚡ 87%</span>
            </div>
          )}

          {/* Screen */}
          <div style={{
            background: C.bg,
            borderRadius: landscape ? 18 : 30,
            height: phoneH - (rideActive ? 20 : landscape ? 20 : 40),
            overflow: "hidden",
            position: "relative",
            transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
          }}>
            {renderScreen()}
            {!rideActive && <TabBar active={activeTab} onTab={handleTab} landscape={landscape} />}
          </div>

          {/* Home indicator */}
          {!landscape && (
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
              <div style={{ width: 100, height: 4, background: "#334155", borderRadius: 2 }} />
            </div>
          )}
        </div>
      </div>

      {/* Screen info */}
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <p style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>
          {rideActive ? "Ride Mode — Full Screen Map" : activeTab === "home" ? "Home Dashboard" : activeTab === "map" ? "Road Quality Map" : activeTab === "trips" ? "Trip Planner" : "Profile"}
        </p>
        <p style={{ color: C.text3, fontSize: 11, marginTop: 4, maxWidth: 400 }}>
          {rideActive
            ? "Tap map to show/hide controls · Auto-hides after 5 seconds · Maximum road visibility"
            : activeTab === "home" ? "Quick actions, nearby hazards, recent rides"
            : activeTab === "map" ? "Road quality overlay with filter chips"
            : activeTab === "trips" ? "Multi-day trip planning with collaborative features"
            : "Rider stats and settings"}
        </p>
      </div>

      <style>{`@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }`}</style>
    </div>
  );
}
