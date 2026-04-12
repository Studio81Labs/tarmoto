import { useState } from "react";

const screens = [
  "home",
  "ride_mode",
  "road_quality",
  "trip_planner",
  "trip_day",
  "road_preview",
  "commute",
  "hazard_report",
];

const screenNames = {
  home: "Home / Dashboard",
  ride_mode: "Ride Mode",
  road_quality: "Road Quality Map",
  trip_planner: "Multi-Day Trip Planner",
  trip_day: "Day Builder",
  road_preview: "Road Preview Card",
  commute: "Commuter Mode",
  hazard_report: "Hazard Report",
};

const Phone = ({ children, title, subtitle }) => (
  <div style={{ width: 375, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
    <div
      style={{
        background: "#1a1a2e",
        borderRadius: 32,
        padding: "12px 12px 16px",
        boxShadow: "0 25px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "6px 20px 4px",
          color: "#94a3b8",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        <span>9:41</span>
        <div
          style={{
            width: 80,
            height: 22,
            background: "#000",
            borderRadius: 12,
          }}
        />
        <span>⚡ 87%</span>
      </div>
      {/* Screen */}
      <div
        style={{
          background: "#0f172a",
          borderRadius: 24,
          minHeight: 680,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {children}
      </div>
      {/* Home indicator */}
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
        <div style={{ width: 120, height: 4, background: "#334155", borderRadius: 2 }} />
      </div>
    </div>
    <p
      style={{
        textAlign: "center",
        color: "#e2e8f0",
        fontSize: 15,
        fontWeight: 700,
        marginTop: 16,
        letterSpacing: "-0.02em",
      }}
    >
      {title}
    </p>
    <p style={{ textAlign: "center", color: "#64748b", fontSize: 12, marginTop: 2 }}>{subtitle}</p>
  </div>
);

const NavBar = ({ active }) => {
  const items = [
    { icon: "🏠", label: "Home" },
    { icon: "🗺️", label: "Map" },
    { icon: "▶️", label: "Ride" },
    { icon: "📅", label: "Trips" },
    { icon: "👤", label: "Profile" },
  ];
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        background: "linear-gradient(to top, #0f172a 60%, transparent)",
        padding: "30px 0 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-around",
          background: "rgba(30,41,59,0.95)",
          margin: "0 12px",
          borderRadius: 20,
          padding: "10px 0",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              textAlign: "center",
              color: active === i ? "#22d3ee" : "#64748b",
              fontSize: 10,
              fontWeight: active === i ? 700 : 500,
            }}
          >
            <div style={{ fontSize: 18, marginBottom: 2 }}>{item.icon}</div>
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
};

const Badge = ({ color, text }) => (
  <span
    style={{
      display: "inline-block",
      background: color + "22",
      color: color,
      fontSize: 10,
      fontWeight: 700,
      padding: "3px 8px",
      borderRadius: 6,
      letterSpacing: "0.03em",
    }}
  >
    {text}
  </span>
);

// ─── SCREEN: HOME ───
const HomeScreen = () => (
  <div style={{ padding: 20 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div>
        <p style={{ color: "#64748b", fontSize: 12, margin: 0 }}>Good morning</p>
        <p style={{ color: "#f1f5f9", fontSize: 22, fontWeight: 800, margin: "2px 0 0", letterSpacing: "-0.03em" }}>
          Rider
        </p>
      </div>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 14,
          background: "linear-gradient(135deg, #22d3ee, #0ea5e9)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
        }}
      >
        🔔
      </div>
    </div>

    {/* Quick actions */}
    <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
      <div
        style={{
          flex: 1,
          background: "linear-gradient(135deg, #22d3ee, #06b6d4)",
          borderRadius: 16,
          padding: "18px 14px",
          color: "#0f172a",
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 6 }}>▶️</div>
        <p style={{ fontWeight: 800, fontSize: 14, margin: 0 }}>Start Ride</p>
        <p style={{ fontSize: 10, margin: "4px 0 0", opacity: 0.7 }}>Free ride or navigate</p>
      </div>
      <div
        style={{
          flex: 1,
          background: "rgba(30,41,59,0.8)",
          borderRadius: 16,
          padding: "18px 14px",
          color: "#e2e8f0",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 6 }}>🏢</div>
        <p style={{ fontWeight: 800, fontSize: 14, margin: 0 }}>Commute</p>
        <p style={{ fontSize: 10, margin: "4px 0 0", color: "#64748b" }}>Home → Work · 12 km</p>
      </div>
    </div>

    {/* Road quality nearby */}
    <div style={{ marginTop: 20 }}>
      <p style={{ color: "#94a3b8", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        ROAD CONDITIONS NEARBY
      </p>
      <div
        style={{
          background: "rgba(30,41,59,0.6)",
          borderRadius: 16,
          padding: 14,
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <Badge color="#22c55e" text="12 EXCELLENT" />
          <Badge color="#eab308" text="5 FAIR" />
          <Badge color="#ef4444" text="2 POOR" />
        </div>
        {/* Mini map placeholder */}
        <div
          style={{
            height: 100,
            borderRadius: 12,
            background: "linear-gradient(135deg, #1e293b, #0f172a)",
            border: "1px solid rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Fake road lines */}
          <div style={{ position: "absolute", width: "100%", height: "100%", opacity: 0.15 }}>
            <div style={{ position: "absolute", top: 30, left: 20, right: 80, height: 3, background: "#22c55e", borderRadius: 2, transform: "rotate(-5deg)" }} />
            <div style={{ position: "absolute", top: 50, left: 60, right: 40, height: 3, background: "#22c55e", borderRadius: 2, transform: "rotate(8deg)" }} />
            <div style={{ position: "absolute", top: 70, left: 30, right: 100, height: 3, background: "#eab308", borderRadius: 2, transform: "rotate(-3deg)" }} />
            <div style={{ position: "absolute", top: 45, left: 150, width: 60, height: 3, background: "#ef4444", borderRadius: 2, transform: "rotate(15deg)" }} />
          </div>
          <span style={{ color: "#475569", fontSize: 11, fontWeight: 600 }}>Tap to explore map</span>
        </div>
      </div>
    </div>

    {/* Active hazards */}
    <div style={{ marginTop: 16 }}>
      <p style={{ color: "#94a3b8", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        ACTIVE HAZARDS
      </p>
      {[
        { icon: "⚠️", text: "Gravel on D35 near Ostrava", time: "12 min ago", dist: "3.2 km" },
        { icon: "🚧", text: "Roadworks on E462", time: "2h ago", dist: "8.1 km" },
      ].map((h, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(30,41,59,0.5)",
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 6,
            border: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <span style={{ fontSize: 20 }}>{h.icon}</span>
          <div style={{ flex: 1 }}>
            <p style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600, margin: 0 }}>{h.text}</p>
            <p style={{ color: "#64748b", fontSize: 10, margin: "2px 0 0" }}>
              {h.time} · {h.dist} away
            </p>
          </div>
        </div>
      ))}
    </div>

    {/* Recent rides */}
    <div style={{ marginTop: 16 }}>
      <p style={{ color: "#94a3b8", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        RECENT RIDES
      </p>
      {[
        { name: "Morning Commute", dist: "12.3 km", dur: "18 min", quality: "4.2" },
        { name: "Beskydy Loop", dist: "142 km", dur: "2h 34m", quality: "4.7" },
      ].map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(30,41,59,0.5)",
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 6,
            border: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <div>
            <p style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600, margin: 0 }}>{r.name}</p>
            <p style={{ color: "#64748b", fontSize: 10, margin: "2px 0 0" }}>
              {r.dist} · {r.dur}
            </p>
          </div>
          <div
            style={{
              background: "#22c55e22",
              color: "#22c55e",
              fontSize: 13,
              fontWeight: 800,
              padding: "4px 10px",
              borderRadius: 8,
            }}
          >
            {r.quality}
          </div>
        </div>
      ))}
    </div>
    <div style={{ height: 80 }} />
    <NavBar active={0} />
  </div>
);

// ─── SCREEN: RIDE MODE ───
const RideScreen = () => (
  <div style={{ position: "relative", height: 680 }}>
    {/* Map background */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(170deg, #1a2744 0%, #0f172a 40%, #162032 100%)",
      }}
    >
      {/* Fake roads */}
      <svg width="100%" height="100%" style={{ position: "absolute", opacity: 0.2 }}>
        <path d="M 50 400 Q 150 300 200 200 T 330 100" stroke="#22d3ee" strokeWidth="4" fill="none" />
        <path d="M 0 350 Q 100 300 180 340 T 375 280" stroke="#22c55e" strokeWidth="3" fill="none" />
        <path d="M 100 500 Q 200 450 250 400" stroke="#eab308" strokeWidth="3" fill="none" />
        <circle cx="200" cy="200" r="6" fill="#22d3ee" opacity="0.8" />
      </svg>
    </div>

    {/* Top bar */}
    <div
      style={{
        position: "relative",
        display: "flex",
        justifyContent: "space-between",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          background: "rgba(15,23,42,0.85)",
          backdropFilter: "blur(10px)",
          borderRadius: 14,
          padding: "8px 14px",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <p style={{ color: "#22d3ee", fontSize: 10, fontWeight: 700, margin: 0, letterSpacing: "0.06em" }}>
          NEXT TURN
        </p>
        <p style={{ color: "#f1f5f9", fontSize: 16, fontWeight: 800, margin: "2px 0 0" }}>↗️ Right in 340m</p>
        <p style={{ color: "#64748b", fontSize: 10, margin: "2px 0 0" }}>onto Hlavní třída</p>
      </div>
      <div
        style={{
          background: "rgba(15,23,42,0.85)",
          backdropFilter: "blur(10px)",
          borderRadius: 14,
          padding: "8px 12px",
          textAlign: "center",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <p style={{ color: "#64748b", fontSize: 9, fontWeight: 700, margin: 0 }}>SPEED</p>
        <p style={{ color: "#f1f5f9", fontSize: 28, fontWeight: 900, margin: 0, letterSpacing: "-0.04em" }}>72</p>
        <p style={{ color: "#64748b", fontSize: 9, margin: 0 }}>km/h</p>
      </div>
    </div>

    {/* Road quality indicator */}
    <div style={{ position: "relative", padding: "0 16px", marginTop: 8 }}>
      <div
        style={{
          background: "rgba(34,197,94,0.15)",
          border: "1px solid rgba(34,197,94,0.3)",
          borderRadius: 12,
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#22c55e",
            boxShadow: "0 0 8px #22c55e",
          }}
        />
        <span style={{ color: "#22c55e", fontSize: 12, fontWeight: 700 }}>Road Quality: Excellent</span>
        <span style={{ color: "#22c55e88", fontSize: 11, marginLeft: "auto" }}>4.8 ★</span>
      </div>
    </div>

    {/* Bottom stats panel */}
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        background: "linear-gradient(to top, rgba(15,23,42,0.98) 70%, transparent)",
        padding: "50px 16px 16px",
      }}
    >
      {/* Hazard alert */}
      <div
        style={{
          background: "rgba(234,179,8,0.12)",
          border: "1px solid rgba(234,179,8,0.3)",
          borderRadius: 12,
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 18 }}>⚠️</span>
        <div>
          <p style={{ color: "#eab308", fontSize: 12, fontWeight: 700, margin: 0 }}>Gravel ahead in 1.2 km</p>
          <p style={{ color: "#eab30888", fontSize: 10, margin: "2px 0 0" }}>Reported 8 min ago by 2 riders</p>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        {[
          { label: "DISTANCE", value: "23.4", unit: "km" },
          { label: "TIME", value: "0:34", unit: "h:m" },
          { label: "ELEVATION", value: "+420", unit: "m" },
          { label: "AVG QUAL.", value: "4.3", unit: "★" },
        ].map((s, i) => (
          <div
            key={i}
            style={{
              background: "rgba(30,41,59,0.7)",
              borderRadius: 12,
              padding: "10px 8px",
              textAlign: "center",
              border: "1px solid rgba(255,255,255,0.04)",
            }}
          >
            <p style={{ color: "#64748b", fontSize: 8, fontWeight: 700, margin: 0, letterSpacing: "0.08em" }}>
              {s.label}
            </p>
            <p style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: "4px 0 0" }}>{s.value}</p>
            <p style={{ color: "#475569", fontSize: 9, margin: 0 }}>{s.unit}</p>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button
          style={{
            flex: 1,
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 14,
            padding: "12px",
            color: "#ef4444",
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ⏹ End Ride
        </button>
        <button
          style={{
            flex: 1,
            background: "rgba(234,179,8,0.15)",
            border: "1px solid rgba(234,179,8,0.3)",
            borderRadius: 14,
            padding: "12px",
            color: "#eab308",
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ⚠️ Report
        </button>
      </div>
    </div>
  </div>
);

// ─── SCREEN: ROAD QUALITY MAP ───
const RoadQualityScreen = () => (
  <div style={{ position: "relative", height: 680 }}>
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(170deg, #1a2744 0%, #0f172a 40%, #162032 100%)",
      }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute" }}>
        {/* Road quality heatmap - colored roads */}
        <path d="M 30 200 Q 80 180 130 220 T 250 180 T 360 150" stroke="#22c55e" strokeWidth="5" fill="none" opacity="0.7" />
        <path d="M 20 300 Q 100 280 160 320 T 300 290" stroke="#22c55e" strokeWidth="4" fill="none" opacity="0.6" />
        <path d="M 80 350 Q 150 330 200 360 T 350 340" stroke="#eab308" strokeWidth="4" fill="none" opacity="0.6" />
        <path d="M 50 420 Q 120 400 180 440 T 320 410" stroke="#ef4444" strokeWidth="4" fill="none" opacity="0.6" />
        <path d="M 100 150 Q 140 250 120 350" stroke="#22c55e" strokeWidth="3" fill="none" opacity="0.5" />
        <path d="M 250 120 Q 260 220 240 340" stroke="#eab308" strokeWidth="3" fill="none" opacity="0.5" />
        <path d="M 180 100 Q 200 180 220 280 T 200 400" stroke="#22c55e" strokeWidth="4" fill="none" opacity="0.6" />
        {/* Rider location */}
        <circle cx="180" cy="280" r="8" fill="#22d3ee" opacity="0.9" />
        <circle cx="180" cy="280" r="16" fill="#22d3ee" opacity="0.2" />
      </svg>
    </div>

    {/* Top search bar */}
    <div style={{ position: "relative", padding: "12px 16px" }}>
      <div
        style={{
          background: "rgba(15,23,42,0.9)",
          backdropFilter: "blur(10px)",
          borderRadius: 14,
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ color: "#64748b" }}>🔍</span>
        <span style={{ color: "#475569", fontSize: 13 }}>Search road or area...</span>
      </div>
    </div>

    {/* Filter chips */}
    <div style={{ position: "relative", padding: "0 16px", display: "flex", gap: 6 }}>
      {[
        { label: "All", active: true },
        { label: "Excellent", color: "#22c55e" },
        { label: "Good", color: "#84cc16" },
        { label: "Fair", color: "#eab308" },
        { label: "Poor", color: "#ef4444" },
      ].map((f, i) => (
        <div
          key={i}
          style={{
            background: f.active ? "rgba(34,211,238,0.15)" : "rgba(30,41,59,0.8)",
            border: `1px solid ${f.active ? "rgba(34,211,238,0.3)" : "rgba(255,255,255,0.06)"}`,
            borderRadius: 20,
            padding: "5px 12px",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {f.color && (
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: f.color }} />
          )}
          <span
            style={{
              color: f.active ? "#22d3ee" : "#94a3b8",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {f.label}
          </span>
        </div>
      ))}
    </div>

    {/* Legend */}
    <div
      style={{
        position: "absolute",
        bottom: 90,
        left: 16,
        background: "rgba(15,23,42,0.9)",
        backdropFilter: "blur(10px)",
        borderRadius: 14,
        padding: "10px 14px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 9, fontWeight: 700, margin: "0 0 6px", letterSpacing: "0.08em" }}>
        ROAD QUALITY
      </p>
      {[
        { color: "#22c55e", label: "Excellent (4.5+)", bar: "100%" },
        { color: "#84cc16", label: "Good (3.5–4.5)", bar: "80%" },
        { color: "#eab308", label: "Fair (2.5–3.5)", bar: "55%" },
        { color: "#ef4444", label: "Poor (< 2.5)", bar: "30%" },
        { color: "#6b7280", label: "No data", bar: "15%" },
      ].map((l, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <div style={{ width: 20, height: 3, background: l.color, borderRadius: 2 }} />
          <span style={{ color: "#94a3b8", fontSize: 9 }}>{l.label}</span>
        </div>
      ))}
    </div>

    {/* Surface type toggle */}
    <div
      style={{
        position: "absolute",
        bottom: 90,
        right: 16,
        background: "rgba(15,23,42,0.9)",
        backdropFilter: "blur(10px)",
        borderRadius: 14,
        padding: "10px 12px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 9, fontWeight: 700, margin: "0 0 6px", letterSpacing: "0.08em" }}>
        LAYERS
      </p>
      {["Quality", "Surface", "Hazards"].map((l, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <div
            style={{
              width: 28,
              height: 16,
              borderRadius: 8,
              background: i === 0 ? "#22d3ee" : "#334155",
              position: "relative",
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 2,
                left: i === 0 ? 14 : 2,
              }}
            />
          </div>
          <span style={{ color: "#94a3b8", fontSize: 10 }}>{l}</span>
        </div>
      ))}
    </div>

    <NavBar active={1} />
  </div>
);

// ─── SCREEN: TRIP PLANNER ───
const TripPlannerScreen = () => (
  <div style={{ padding: 20 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <p style={{ color: "#f1f5f9", fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: "-0.03em" }}>
        Plan a Trip
      </p>
      <div
        style={{
          background: "rgba(34,211,238,0.12)",
          border: "1px solid rgba(34,211,238,0.25)",
          borderRadius: 10,
          padding: "6px 12px",
          color: "#22d3ee",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        + New Trip
      </div>
    </div>

    {/* Trip config */}
    <div
      style={{
        background: "rgba(30,41,59,0.6)",
        borderRadius: 16,
        padding: 14,
        marginTop: 16,
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        TRIP SETTINGS
      </p>
      {[
        { label: "Region", value: "Beskydy & Jeseníky", icon: "📍" },
        { label: "Days", value: "3 days", icon: "📅" },
        { label: "Daily distance", value: "200–300 km", icon: "📏" },
        { label: "Road preference", value: "Curvy + Good surface", icon: "🛣️" },
        { label: "Min. road quality", value: "3.5+ ★", icon: "✨" },
        { label: "Riders", value: "4 riders joined", icon: "👥" },
      ].map((s, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 0",
            borderBottom: i < 5 ? "1px solid rgba(255,255,255,0.04)" : "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>{s.icon}</span>
            <span style={{ color: "#94a3b8", fontSize: 12 }}>{s.label}</span>
          </div>
          <span style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600 }}>{s.value}</span>
        </div>
      ))}
    </div>

    {/* Generate button */}
    <button
      style={{
        width: "100%",
        background: "linear-gradient(135deg, #22d3ee, #06b6d4)",
        border: "none",
        borderRadius: 14,
        padding: "14px",
        color: "#0f172a",
        fontWeight: 800,
        fontSize: 14,
        marginTop: 14,
        cursor: "pointer",
        letterSpacing: "-0.01em",
      }}
    >
      🗺️ Generate Trip Route
    </button>

    {/* Fun zones discovered */}
    <div style={{ marginTop: 16 }}>
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        FUN ZONES DISCOVERED
      </p>
      {[
        { name: "Pustevny Pass Area", score: "4.8", roads: "12 roads", km: "87 km of curves" },
        { name: "Štramberk – Kopřivnice", score: "4.5", roads: "8 roads", km: "52 km of curves" },
        { name: "Jeseníky North Ridge", score: "4.6", roads: "15 roads", km: "110 km of curves" },
      ].map((z, i) => (
        <div
          key={i}
          style={{
            background: "rgba(30,41,59,0.5)",
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 8,
            border: "1px solid rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <p style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 700, margin: 0 }}>{z.name}</p>
            <p style={{ color: "#64748b", fontSize: 10, margin: "3px 0 0" }}>
              {z.roads} · {z.km}
            </p>
          </div>
          <div
            style={{
              background: "#22c55e22",
              color: "#22c55e",
              fontWeight: 800,
              fontSize: 14,
              padding: "4px 10px",
              borderRadius: 8,
            }}
          >
            {z.score}
          </div>
        </div>
      ))}
    </div>
    <div style={{ height: 80 }} />
    <NavBar active={3} />
  </div>
);

// ─── SCREEN: DAY BUILDER ───
const TripDayScreen = () => (
  <div style={{ padding: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "#64748b", fontSize: 14 }}>←</span>
      <p style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: 0 }}>Day 2: Beskydy Loop</p>
    </div>
    <p style={{ color: "#64748b", fontSize: 11, margin: "4px 0 0 24px" }}>248 km · ~4h 20m · Avg quality: 4.5 ★</p>

    {/* Mini elevation profile */}
    <div
      style={{
        background: "rgba(30,41,59,0.6)",
        borderRadius: 14,
        padding: 12,
        marginTop: 14,
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 9, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
        ELEVATION PROFILE
      </p>
      <svg width="100%" height="60" viewBox="0 0 300 60">
        <defs>
          <linearGradient id="elev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M 0 50 Q 30 45 60 35 T 120 20 T 180 15 T 210 25 T 260 40 T 300 45 L 300 60 L 0 60 Z" fill="url(#elev)" />
        <path d="M 0 50 Q 30 45 60 35 T 120 20 T 180 15 T 210 25 T 260 40 T 300 45" stroke="#22d3ee" strokeWidth="2" fill="none" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ color: "#475569", fontSize: 9 }}>320m</span>
        <span style={{ color: "#22d3ee", fontSize: 9, fontWeight: 700 }}>↑ 1,240m total climb</span>
        <span style={{ color: "#475569", fontSize: 9 }}>890m</span>
      </div>
    </div>

    {/* Route segments */}
    <div style={{ marginTop: 14 }}>
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
        ROUTE SEGMENTS
      </p>
      {[
        { name: "Hotel → Frenštát", km: "18 km", type: "Transfer", quality: "3.8", color: "#84cc16", surface: "Asphalt" },
        { name: "Frenštát – Pustevny", km: "22 km", type: "Fun road! 🔥", quality: "4.9", color: "#22c55e", surface: "Smooth asphalt" },
        { name: "Pustevny – Rožnov", km: "28 km", type: "Scenic curves", quality: "4.6", color: "#22c55e", surface: "Asphalt" },
        { name: "☕ Coffee stop Rožnov", km: "—", type: "30 min break", quality: "", color: "", surface: "" },
        { name: "Rožnov – Velké Karlovice", km: "35 km", type: "Fun road! 🔥", quality: "4.7", color: "#22c55e", surface: "Smooth asphalt" },
        { name: "⛽ Fuel stop", km: "—", type: "Velké Karlovice", quality: "", color: "", surface: "" },
        { name: "V. Karlovice – Jablunkov", km: "42 km", type: "Mixed curves", quality: "4.1", color: "#84cc16", surface: "Asphalt, 2km gravel" },
        { name: "Jablunkov → Hotel", km: "38 km", type: "Transfer", quality: "3.5", color: "#eab308", surface: "Mixed" },
      ].map((s, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 0",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          {/* Timeline dot */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16 }}>
            <div
              style={{
                width: s.quality ? 10 : 8,
                height: s.quality ? 10 : 8,
                borderRadius: "50%",
                background: s.color || "#475569",
                border: s.quality ? "none" : "2px dashed #475569",
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600, margin: 0 }}>{s.name}</p>
            <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
              {s.km !== "—" && <span style={{ color: "#64748b", fontSize: 10 }}>{s.km}</span>}
              <span style={{ color: s.type.includes("🔥") ? "#f97316" : "#64748b", fontSize: 10, fontWeight: s.type.includes("🔥") ? 700 : 400 }}>{s.type}</span>
              {s.surface && <span style={{ color: "#475569", fontSize: 10 }}>· {s.surface}</span>}
            </div>
          </div>
          {s.quality && (
            <div
              style={{
                background: s.color + "22",
                color: s.color,
                fontWeight: 800,
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 6,
              }}
            >
              {s.quality}
            </div>
          )}
        </div>
      ))}
    </div>

    {/* Collaborative riders */}
    <div
      style={{
        background: "rgba(30,41,59,0.5)",
        borderRadius: 12,
        padding: "10px 12px",
        marginTop: 12,
        border: "1px solid rgba(255,255,255,0.04)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex" }}>
          {["🟢", "🔵", "🟡", "🟣"].map((c, i) => (
            <div
              key={i}
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "#1e293b",
                border: "2px solid #0f172a",
                marginLeft: i > 0 ? -8 : 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
              }}
            >
              {c}
            </div>
          ))}
        </div>
        <span style={{ color: "#94a3b8", fontSize: 11 }}>4 riders · 2 votes pending</span>
      </div>
      <span style={{ color: "#22d3ee", fontSize: 11, fontWeight: 700 }}>Chat</span>
    </div>
    <div style={{ height: 20 }} />
  </div>
);

// ─── SCREEN: ROAD PREVIEW CARD ───
const RoadPreviewScreen = () => (
  <div style={{ padding: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
      <span style={{ color: "#64748b", fontSize: 14 }}>←</span>
      <p style={{ color: "#f1f5f9", fontSize: 16, fontWeight: 800, margin: 0 }}>Road Preview</p>
    </div>

    {/* Road hero */}
    <div
      style={{
        background: "linear-gradient(135deg, #1e3a5f, #0f172a)",
        borderRadius: 16,
        padding: 16,
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: 0 }}>Frenštát – Pustevny</p>
          <p style={{ color: "#64748b", fontSize: 11, margin: "4px 0 0" }}>Road 483 · Beskydy Mountains</p>
        </div>
        <div
          style={{
            background: "#22c55e22",
            color: "#22c55e",
            fontWeight: 900,
            fontSize: 22,
            padding: "6px 14px",
            borderRadius: 12,
          }}
        >
          4.9
        </div>
      </div>

      {/* Tags */}
      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        <Badge color="#22c55e" text="EXCELLENT SURFACE" />
        <Badge color="#f97316" text="VERY CURVY" />
        <Badge color="#8b5cf6" text="SCENIC" />
        <Badge color="#06b6d4" text="MOUNTAIN PASS" />
      </div>
    </div>

    {/* Stats */}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
      {[
        { label: "Length", value: "22 km" },
        { label: "Curves", value: "47" },
        { label: "Elevation", value: "+580m" },
        { label: "Surface", value: "Asphalt" },
        { label: "Avg. speed", value: "52 km/h" },
        { label: "Riders/mo", value: "342" },
      ].map((s, i) => (
        <div
          key={i}
          style={{
            background: "rgba(30,41,59,0.5)",
            borderRadius: 10,
            padding: "8px 10px",
            textAlign: "center",
            border: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <p style={{ color: "#64748b", fontSize: 9, fontWeight: 600, margin: 0 }}>{s.label}</p>
          <p style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 800, margin: "2px 0 0" }}>{s.value}</p>
        </div>
      ))}
    </div>

    {/* Surface quality breakdown */}
    <div
      style={{
        background: "rgba(30,41,59,0.5)",
        borderRadius: 14,
        padding: 12,
        marginTop: 12,
        border: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
        SURFACE QUALITY BY SEGMENT
      </p>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
        <div style={{ flex: 65, background: "#22c55e", borderRadius: 4 }} />
        <div style={{ flex: 25, background: "#84cc16", borderRadius: 4 }} />
        <div style={{ flex: 8, background: "#eab308", borderRadius: 4 }} />
        <div style={{ flex: 2, background: "#ef4444", borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ color: "#22c55e", fontSize: 9 }}>65% excellent</span>
        <span style={{ color: "#84cc16", fontSize: 9 }}>25% good</span>
        <span style={{ color: "#eab308", fontSize: 9 }}>8% fair</span>
        <span style={{ color: "#ef4444", fontSize: 9 }}>2% poor</span>
      </div>
    </div>

    {/* Hazards */}
    <div style={{ marginTop: 12 }}>
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
        KNOWN HAZARDS (2)
      </p>
      <div
        style={{
          background: "rgba(234,179,8,0.08)",
          borderRadius: 10,
          padding: "8px 10px",
          border: "1px solid rgba(234,179,8,0.15)",
          marginBottom: 6,
        }}
      >
        <p style={{ color: "#eab308", fontSize: 11, fontWeight: 600, margin: 0 }}>⚠️ Loose gravel at km 14.2</p>
        <p style={{ color: "#eab30888", fontSize: 9, margin: "2px 0 0" }}>Last confirmed 3 days ago</p>
      </div>
      <div
        style={{
          background: "rgba(234,179,8,0.08)",
          borderRadius: 10,
          padding: "8px 10px",
          border: "1px solid rgba(234,179,8,0.15)",
        }}
      >
        <p style={{ color: "#eab308", fontSize: 11, fontWeight: 600, margin: 0 }}>⚠️ Narrow section at km 18.5</p>
        <p style={{ color: "#eab30888", fontSize: 9, margin: "2px 0 0" }}>Permanent · Watch for oncoming</p>
      </div>
    </div>

    {/* Rider reviews */}
    <div style={{ marginTop: 12 }}>
      <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
        RIDER REVIEWS (28)
      </p>
      <div
        style={{
          background: "rgba(30,41,59,0.5)",
          borderRadius: 10,
          padding: "8px 10px",
          border: "1px solid rgba(255,255,255,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 600 }}>Martin K.</span>
          <span style={{ color: "#22c55e", fontSize: 11 }}>★★★★★</span>
        </div>
        <p style={{ color: "#94a3b8", fontSize: 10, margin: "4px 0 0", lineHeight: 1.4 }}>
          One of the best roads in Beskydy. Fresh asphalt since 2024 renovation. Amazing views at the top. Go early to avoid tourist traffic.
        </p>
        <p style={{ color: "#475569", fontSize: 9, margin: "4px 0 0" }}>Rode 2 weeks ago · BMW R1250GS</p>
      </div>
    </div>

    {/* Action */}
    <button
      style={{
        width: "100%",
        background: "linear-gradient(135deg, #22d3ee, #06b6d4)",
        border: "none",
        borderRadius: 14,
        padding: "12px",
        color: "#0f172a",
        fontWeight: 800,
        fontSize: 13,
        marginTop: 14,
        cursor: "pointer",
      }}
    >
      + Add to Trip
    </button>
  </div>
);

// ─── SCREEN: COMMUTER ───
const CommuteScreen = () => (
  <div style={{ position: "relative", height: 680 }}>
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(170deg, #1a2744 0%, #0f172a 40%, #162032 100%)",
      }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", opacity: 0.25 }}>
        <path d="M 60 500 Q 120 400 180 350 T 280 250 T 330 150" stroke="#22c55e" strokeWidth="5" fill="none" />
        <circle cx="60" cy="500" r="8" fill="#22d3ee" />
        <circle cx="330" cy="150" r="8" fill="#f97316" />
      </svg>
    </div>

    <div style={{ position: "relative", padding: 20 }}>
      <p style={{ color: "#f1f5f9", fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: "-0.03em" }}>Commute</p>
      <p style={{ color: "#64748b", fontSize: 12, margin: "4px 0 0" }}>Wednesday, April 10</p>

      {/* Route card */}
      <div
        style={{
          background: "rgba(15,23,42,0.9)",
          backdropFilter: "blur(10px)",
          borderRadius: 16,
          padding: 14,
          marginTop: 16,
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22d3ee" }} />
            <div style={{ width: 1, height: 30, background: "#334155", margin: "4px auto" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#f97316" }} />
          </div>
          <div>
            <p style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600, margin: 0 }}>Home</p>
            <p style={{ color: "#475569", fontSize: 10, margin: "2px 0 20px" }}>Ostrava-Poruba</p>
            <p style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600, margin: 0 }}>Work</p>
            <p style={{ color: "#475569", fontSize: 10, margin: "2px 0 0" }}>Ostrava-centrum</p>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <p style={{ color: "#f1f5f9", fontSize: 24, fontWeight: 900, margin: 0 }}>18</p>
            <p style={{ color: "#64748b", fontSize: 10, margin: 0 }}>min</p>
          </div>
        </div>

        {/* Route status */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <Badge color="#22c55e" text="✓ CLEAR ROUTE" />
          <Badge color="#22c55e" text="ROAD QUALITY 4.1" />
        </div>
      </div>

      {/* Alerts for commute */}
      <div style={{ marginTop: 14 }}>
        <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
          TODAY'S ALERTS
        </p>
        <div
          style={{
            background: "rgba(34,197,94,0.08)",
            border: "1px solid rgba(34,197,94,0.2)",
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 8,
          }}
        >
          <p style={{ color: "#22c55e", fontSize: 12, fontWeight: 600, margin: 0 }}>
            ✓ No new hazards on your route
          </p>
        </div>
        <div
          style={{
            background: "rgba(96,165,250,0.08)",
            border: "1px solid rgba(96,165,250,0.2)",
            borderRadius: 12,
            padding: "10px 12px",
          }}
        >
          <p style={{ color: "#60a5fa", fontSize: 12, fontWeight: 600, margin: 0 }}>🌤️ 14°C · Dry roads · Wind 12 km/h</p>
          <p style={{ color: "#60a5fa88", fontSize: 10, margin: "2px 0 0" }}>Good riding conditions</p>
        </div>
      </div>

      {/* Start commute button */}
      <button
        style={{
          width: "100%",
          background: "linear-gradient(135deg, #22d3ee, #06b6d4)",
          border: "none",
          borderRadius: 14,
          padding: "16px",
          color: "#0f172a",
          fontWeight: 800,
          fontSize: 15,
          marginTop: 14,
          cursor: "pointer",
          letterSpacing: "-0.01em",
        }}
      >
        🏍️ Start Commute
      </button>

      {/* Weekly stats */}
      <div
        style={{
          background: "rgba(30,41,59,0.5)",
          borderRadius: 14,
          padding: 12,
          marginTop: 14,
          border: "1px solid rgba(255,255,255,0.04)",
        }}
      >
        <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.08em" }}>
          THIS WEEK
        </p>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          {["M", "T", "W", "T", "F"].map((d, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: i < 2 ? "#22c55e22" : i === 2 ? "#22d3ee22" : "#1e293b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  marginBottom: 4,
                }}
              >
                {i < 2 ? "✓" : i === 2 ? "→" : ""}
              </div>
              <span style={{ color: "#64748b", fontSize: 9 }}>{d}</span>
            </div>
          ))}
        </div>
        <p style={{ color: "#64748b", fontSize: 10, margin: "8px 0 0", textAlign: "center" }}>
          4 rides · 48 km · avg 17 min · 2.1 L fuel est.
        </p>
      </div>
    </div>
    <NavBar active={0} />
  </div>
);

// ─── SCREEN: HAZARD REPORT ───
const HazardReportScreen = () => (
  <div style={{ padding: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <span style={{ color: "#64748b", fontSize: 14 }}>←</span>
      <p style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: 0 }}>Report Hazard</p>
    </div>

    <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 14px" }}>
      📍 Current location: Road 483, km 14.2
    </p>

    {/* Hazard types - big tap targets */}
    <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "0 0 10px" }}>
      HAZARD TYPE
    </p>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
      {[
        { icon: "🕳️", label: "Pothole", selected: false },
        { icon: "🪨", label: "Gravel", selected: true },
        { icon: "🛢️", label: "Oil spill", selected: false },
        { icon: "🚧", label: "Roadworks", selected: false },
        { icon: "🐾", label: "Animals", selected: false },
        { icon: "👮", label: "Police", selected: false },
        { icon: "🌊", label: "Flooding", selected: false },
        { icon: "🧊", label: "Ice", selected: false },
        { icon: "⚠️", label: "Other", selected: false },
      ].map((h, i) => (
        <div
          key={i}
          style={{
            background: h.selected ? "rgba(234,179,8,0.15)" : "rgba(30,41,59,0.5)",
            border: `1px solid ${h.selected ? "rgba(234,179,8,0.4)" : "rgba(255,255,255,0.06)"}`,
            borderRadius: 14,
            padding: "14px 8px",
            textAlign: "center",
            cursor: "pointer",
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 4 }}>{h.icon}</div>
          <p
            style={{
              color: h.selected ? "#eab308" : "#94a3b8",
              fontSize: 11,
              fontWeight: h.selected ? 700 : 500,
              margin: 0,
            }}
          >
            {h.label}
          </p>
        </div>
      ))}
    </div>

    {/* Severity */}
    <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "16px 0 8px" }}>
      SEVERITY
    </p>
    <div style={{ display: "flex", gap: 8 }}>
      {[
        { label: "Low", color: "#eab308" },
        { label: "Medium", color: "#f97316", selected: true },
        { label: "High", color: "#ef4444" },
      ].map((s, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            background: s.selected ? s.color + "22" : "rgba(30,41,59,0.5)",
            border: `1px solid ${s.selected ? s.color + "55" : "rgba(255,255,255,0.06)"}`,
            borderRadius: 10,
            padding: "10px",
            textAlign: "center",
            cursor: "pointer",
          }}
        >
          <span style={{ color: s.selected ? s.color : "#64748b", fontSize: 12, fontWeight: 700 }}>{s.label}</span>
        </div>
      ))}
    </div>

    {/* Optional note */}
    <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", margin: "16px 0 8px" }}>
      NOTE (OPTIONAL)
    </p>
    <div
      style={{
        background: "rgba(30,41,59,0.5)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        padding: "10px 12px",
        color: "#94a3b8",
        fontSize: 12,
        minHeight: 48,
      }}
    >
      Loose gravel on right side after the curve...
    </div>

    {/* Submit */}
    <button
      style={{
        width: "100%",
        background: "linear-gradient(135deg, #eab308, #f59e0b)",
        border: "none",
        borderRadius: 14,
        padding: "14px",
        color: "#0f172a",
        fontWeight: 800,
        fontSize: 14,
        marginTop: 16,
        cursor: "pointer",
      }}
    >
      ⚠️ Submit Hazard Report
    </button>
    <p style={{ color: "#475569", fontSize: 10, textAlign: "center", marginTop: 8 }}>
      Reports auto-expire after 72h unless confirmed by other riders
    </p>
  </div>
);

// ─── MAIN APP ───
const screenComponents = {
  home: HomeScreen,
  ride_mode: RideScreen,
  road_quality: RoadQualityScreen,
  trip_planner: TripPlannerScreen,
  trip_day: TripDayScreen,
  road_preview: RoadPreviewScreen,
  commute: CommuteScreen,
  hazard_report: HazardReportScreen,
};

const descriptions = {
  home: "Dashboard with quick actions, nearby road conditions, active hazards, and recent rides",
  ride_mode: "Active navigation with speed, road quality indicator, hazard alerts, and ride stats",
  road_quality: "Map overlay showing road surface quality heatmap with filters and layer toggles",
  trip_planner: "Multi-day trip configuration with Fun Zone discovery and auto-route generation",
  trip_day: "Day-by-day route breakdown with segments, quality scores, stops, and collaboration",
  road_preview: "Detailed road card replacing Street View — surface data, curves, hazards, reviews",
  commute: "One-tap commute mode with route status, weather, alerts, and weekly summary",
  hazard_report: "Quick hazard reporting with large tap targets for gloved hands",
};

export default function TarmotoWireframes() {
  const [activeScreen, setActiveScreen] = useState("home");
  const Screen = screenComponents[activeScreen];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080c14",
        fontFamily: "'DM Sans', sans-serif",
        padding: "30px 20px",
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <h1
          style={{
            color: "#22d3ee",
            fontSize: 28,
            fontWeight: 900,
            margin: 0,
            letterSpacing: "-0.04em",
          }}
        >
          TARMOTO
        </h1>
        <p style={{ color: "#475569", fontSize: 13, margin: "4px 0 0", fontStyle: "italic" }}>
          Know the road before you ride it
        </p>
        <p style={{ color: "#334155", fontSize: 11, margin: "10px 0 0" }}>
          Interactive Wireframes · 8 Core Screens · Tap to navigate
        </p>
      </div>

      {/* Screen selector */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 6,
          marginBottom: 30,
          maxWidth: 600,
          margin: "0 auto 30px",
        }}
      >
        {screens.map((s) => (
          <button
            key={s}
            onClick={() => setActiveScreen(s)}
            style={{
              background: activeScreen === s ? "rgba(34,211,238,0.15)" : "rgba(30,41,59,0.5)",
              border: `1px solid ${activeScreen === s ? "rgba(34,211,238,0.4)" : "rgba(255,255,255,0.06)"}`,
              borderRadius: 10,
              padding: "8px 14px",
              color: activeScreen === s ? "#22d3ee" : "#64748b",
              fontSize: 12,
              fontWeight: activeScreen === s ? 700 : 500,
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              transition: "all 0.2s",
            }}
          >
            {screenNames[s]}
          </button>
        ))}
      </div>

      {/* Phone mockup */}
      <Phone title={screenNames[activeScreen]} subtitle={descriptions[activeScreen]}>
        <Screen />
      </Phone>
    </div>
  );
}
