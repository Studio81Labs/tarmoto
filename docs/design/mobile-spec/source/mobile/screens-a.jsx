// screens-a.jsx — Home (map-first / list-first) + Road Quality Explorer.

function mapThemeFromCfg(cfg) {
  return cfg.mapStyle === "light" ? "light" : "dark";
}

// ── Shared bits ─────────────────────────────────────────────────
function Avatar({ size = 42 }) {
  const t = useT();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: t.fg,
        color: t.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: t.sans,
        fontWeight: 800,
        fontSize: size * 0.36,
        flexShrink: 0,
      }}
    >
      L
    </div>
  );
}

function CommuteCard({ onStart, condensed }) {
  const t = useT();
  return (
    <div
      style={{
        padding: condensed ? 16 : 18,
        borderRadius: t.rLg,
        background: "#141519",
        color: "#F5EFE6",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: -34,
          top: -34,
          width: 150,
          height: 150,
          borderRadius: 999,
          background: t.accent,
          opacity: 0.16,
        }}
      />
      <div style={{ position: "relative" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Stamp color="rgba(245,239,230,0.6)">Daily commute</Stamp>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: t.mono,
              fontSize: 11,
              color: QC[4],
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 9,
                background: QC[4],
              }}
            />{" "}
            4°C · Clear
          </span>
        </div>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 23,
            letterSpacing: -0.4,
            marginTop: 8,
            color: "#F5EFE6",
          }}
        >
          Home → Studio
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 10,
            fontFamily: t.mono,
            fontSize: 12,
            color: "rgba(245,239,230,0.6)",
          }}
        >
          <span>
            <b style={{ color: "#F5EFE6", fontSize: 15 }}>14</b> min
          </span>
          <span>
            <b style={{ color: "#F5EFE6", fontSize: 15 }}>8.4</b> km
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <QBars q={4} size={5} /> good
          </span>
        </div>
        <div
          style={{
            marginTop: 14,
            padding: "11px 12px",
            borderRadius: t.rSm + 2,
            background: "rgba(255,106,26,0.13)",
            border: "1px solid rgba(255,106,26,0.4)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              background: t.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="alert" size={15} color="#0E0E10" sw={2} />
          </div>
          <div
            style={{
              flex: 1,
              fontSize: 12,
              lineHeight: 1.35,
              color: "#F5EFE6",
            }}
          >
            <b style={{ color: t.accent }}>New pothole</b> on Via Gramsci · 2
            riders confirmed
          </div>
        </div>
        <button
          onClick={onStart}
          style={{
            marginTop: 14,
            width: "100%",
            padding: 14,
            borderRadius: t.rSm + 2,
            border: "none",
            cursor: "pointer",
            background: t.accent,
            color: "#0E0E10",
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon name="nav" size={18} color="#0E0E10" sw={2} /> Start commute
        </button>
      </div>
    </div>
  );
}

function SuggestedRide({ onOpen }) {
  const t = useT();
  return (
    <Card raised pad={14} style={{ cursor: "pointer" }} onClick={onOpen}>
      <MiniRoute h={118} showHazard seed={1} />
      <div
        style={{
          marginTop: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: 18,
              letterSpacing: -0.3,
            }}
          >
            Stelvio Pass Loop
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 5,
              fontFamily: t.mono,
              fontSize: 11,
              color: t.mute,
              fontWeight: 600,
            }}
          >
            <span>186 km</span>
            <span>·</span>
            <span>+2,758 m</span>
            <span>·</span>
            <span>4h 12m</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <QBars q={4} size={7} />
          <div style={{ marginTop: 5 }}>
            <Stamp size={9}>Great</Stamp>
          </div>
        </div>
      </div>
    </Card>
  );
}

function StatStrip() {
  const t = useT();
  const stats = [
    ["This week", "127", "km"],
    ["Rides", "4", "logged"],
    ["Reports", "9", "hazards"],
  ];
  return (
    <div
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}
    >
      {stats.map(([l, n, u]) => (
        <Card raised key={l} pad={12}>
          <Stamp size={9}>{l}</Stamp>
          <div
            style={{
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: 24,
              lineHeight: 1,
              marginTop: 6,
            }}
          >
            {n}
          </div>
          <div
            style={{
              fontFamily: t.mono,
              fontSize: 10,
              color: t.mute,
              marginTop: 3,
            }}
          >
            {u}
          </div>
        </Card>
      ))}
    </div>
  );
}

function NearbyRoads() {
  const t = useT();
  const roads = [
    ["Passo Gavia", "2,621 m · 34 turns", 4],
    ["Mortirolo", "1,852 m · 39 turns", 3],
    ["Val di Mello", "Resurfaced ’25", 5],
  ];
  return (
    <Card raised pad={0} style={{ overflow: "hidden" }}>
      {roads.map(([n, s, q], i) => (
        <div
          key={n}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "13px 15px",
            borderBottom: i < roads.length - 1 ? "1px solid " + t.line : "none",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: t.rSm - 2,
              background: t.bg,
              border: "1px solid " + t.line,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="mountain" size={17} color={t.dim} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: t.sans, fontWeight: 700, fontSize: 14 }}>
              {n}
            </div>
            <div
              style={{
                fontFamily: t.mono,
                fontSize: 11,
                color: t.mute,
                marginTop: 2,
              }}
            >
              {s}
            </div>
          </div>
          <QBars q={q} size={6} />
        </div>
      ))}
    </Card>
  );
}

// ── HOME ────────────────────────────────────────────────────────
function HomeScreen({ cfg, onStart, onOpenRide }) {
  const t = useT();
  const onDark = t.dark;
  const Header = () => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <Stamp>Tue · 06:42</Stamp>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: t.h1,
            letterSpacing: t.track,
            marginTop: 2,
          }}
        >
          Morning, Luca.
        </div>
      </div>
      <Avatar />
    </div>
  );

  if (cfg.homeLayout === "map") {
    const mapDark = mapThemeFromCfg(cfg) !== "light";
    return (
      <Screen onDark={onDark}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            ...(t.land ? {} : { height: "56%" }),
          }}
        >
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <TarmotoMap
              theme={mapThemeFromCfg(cfg)}
              mapStyle="heatmap"
              progress={20}
              accent={t.accent}
              showLabels={false}
            />
          </div>
        </div>
        <StatusBar onDark={mapDark} />
        {!t.land && (
          <div
            style={{
              position: "absolute",
              top: 54,
              left: 18,
              right: 18,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              zIndex: 10,
            }}
          >
            <div
              style={{
                padding: "9px 14px",
                borderRadius: 999,
                background: "rgba(14,14,16,0.55)",
                backdropFilter: "blur(12px)",
                color: "#F5EFE6",
              }}
            >
              <Stamp color="rgba(245,239,230,0.6)">Tue · 4°C</Stamp>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 18,
                  marginTop: 1,
                }}
              >
                Morning, Luca.
              </div>
            </div>
            <Avatar />
          </div>
        )}
        <div
          style={{
            ...sheetStyle(t, { maxH: "58%" }),
            ...(t.land ? {} : { top: "46%", maxHeight: "none" }),
          }}
        >
          {!t.land && (
            <div
              style={{
                width: 42,
                height: 5,
                borderRadius: 9,
                background: t.faint,
                margin: "10px auto 4px",
                flexShrink: 0,
              }}
            />
          )}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: t.land ? "16px 16px 16px" : "6px 18px 130px",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {t.land && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <Stamp>Tue · 06:42 · 4°C</Stamp>
                    <div
                      style={{
                        fontFamily: t.sans,
                        fontWeight: 800,
                        fontSize: 24,
                        letterSpacing: t.track,
                        marginTop: 2,
                      }}
                    >
                      Morning, Luca.
                    </div>
                  </div>
                  <Avatar size={36} />
                </div>
              )}
              <CommuteCard onStart={onStart} condensed />
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 10,
                  }}
                >
                  <Stamp>Suggested for Saturday</Stamp>
                  <Stamp color={t.faint}>See all →</Stamp>
                </div>
                <SuggestedRide onOpen={onOpenRide} />
              </div>
              <StatStrip />
            </div>
          </div>
        </div>
      </Screen>
    );
  }

  // list-first
  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <Scroll pad={20} bottomPad={130}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            paddingTop: 4,
          }}
        >
          <Header />
          <CommuteCard onStart={onStart} />
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 10,
              }}
            >
              <Stamp>Suggested for Saturday</Stamp>
              <Stamp color={t.faint}>See all →</Stamp>
            </div>
            <SuggestedRide onOpen={onOpenRide} />
          </div>
          <StatStrip />
          <div>
            <div style={{ marginBottom: 10 }}>
              <Stamp>Roads near you</Stamp>
            </div>
            <NearbyRoads />
          </div>
        </div>
      </Scroll>
    </Screen>
  );
}

// ── ROAD QUALITY EXPLORER ───────────────────────────────────────
const EXPLORER_ROADS = [
  {
    id: 0,
    name: "Tornante 18 → 24",
    road: "SS38 · Passo dello Stelvio",
    q: 2,
    km: "2.4 km",
    turns: "48 turns",
    peak: "2,758 m",
    passes: 184,
    trend: "+1%",
    hazards: 3,
    surface: "Asphalt",
    note: "Rough tarmac between hairpins 19–22. Aggregated from 184 rider passes, last updated 3 days ago.",
  },
  {
    id: 1,
    name: "Bormio approach",
    road: "SS300 · Valdidentro",
    q: 5,
    km: "11.2 km",
    turns: "22 turns",
    peak: "1,820 m",
    passes: 326,
    trend: "+4%",
    hazards: 0,
    surface: "Asphalt",
    note: "Freshly resurfaced in 2025. Consistently excellent across 326 passes — a hero stretch.",
  },
  {
    id: 2,
    name: "Gavia north ramp",
    road: "SP29 · Passo Gavia",
    q: 3,
    km: "6.8 km",
    turns: "31 turns",
    peak: "2,621 m",
    passes: 97,
    trend: "−2%",
    hazards: 1,
    surface: "Mixed",
    note: "Narrow and patchy in places. Some gravel wash near km 4 after spring melt.",
  },
];

function ExplorerScreen({ cfg }) {
  const t = useT();
  const [sel, setSel] = React.useState(0);
  const [filter, setFilter] = React.useState("All");
  const road = EXPLORER_ROADS[sel];
  const mapDark = mapThemeFromCfg(cfg) !== "light";

  return (
    <Screen onDark>
      <div style={{ position: "absolute", inset: 0 }}>
        <TarmotoMap
          theme={mapThemeFromCfg(cfg)}
          mapStyle="heatmap"
          progress={road.id === 0 ? 54 : road.id === 1 ? 95 : 65}
          accent={t.accent}
          showLabels
        />
      </div>
      <StatusBar onDark={mapDark} />

      {/* filters (portrait floats over map) */}
      {!t.land && (
        <div
          style={{
            position: "absolute",
            top: 52,
            left: 0,
            right: 0,
            zIndex: 12,
            display: "flex",
            gap: 7,
            padding: "0 16px",
            overflowX: "auto",
          }}
        >
          {["All", "Excellent", "Gravel", "Curvy 4+", "Hazards"].map((f) => (
            <Chip
              key={f}
              active={filter === f}
              dark={mapDark}
              accent={filter === f}
              onClick={() => setFilter(f)}
              style={{
                background:
                  filter === f
                    ? t.accent
                    : mapDark
                      ? "rgba(14,14,16,0.55)"
                      : "rgba(245,239,230,0.8)",
                color:
                  filter === f ? "#0E0E10" : mapDark ? "#F5EFE6" : "#0E0E10",
                backdropFilter: "blur(12px)",
                border: "none",
              }}
            >
              {f === "All" && (
                <Icon
                  name="filter"
                  size={13}
                  color={
                    filter === f ? "#0E0E10" : mapDark ? "#F5EFE6" : "#0E0E10"
                  }
                />
              )}
              {f}
            </Chip>
          ))}
        </div>
      )}

      {/* layers btn */}
      <button
        style={{
          position: "absolute",
          right: 16,
          top: t.land ? 64 : 100,
          zIndex: 12,
          width: 44,
          height: 44,
          borderRadius: 14,
          background: mapDark ? "rgba(14,14,16,0.6)" : "rgba(245,239,230,0.85)",
          backdropFilter: "blur(12px)",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: mapDark ? "#F5EFE6" : "#0E0E10",
          boxShadow: "0 6px 18px rgba(14,14,16,0.2)",
        }}
      >
        <Icon name="layers" size={21} />
      </button>

      {/* legend (portrait only) */}
      {!t.land && (
        <div
          style={{
            position: "absolute",
            left: 16,
            top: 100,
            zIndex: 12,
            padding: "9px 12px",
            borderRadius: 12,
            background: mapDark
              ? "rgba(14,14,16,0.6)"
              : "rgba(245,239,230,0.85)",
            backdropFilter: "blur(12px)",
          }}
        >
          <Stamp size={9} color={mapDark ? "rgba(245,239,230,0.6)" : t.mute}>
            Quality
          </Stamp>
          <div
            style={{
              display: "flex",
              gap: 3,
              marginTop: 6,
              alignItems: "center",
            }}
          >
            {QC.map((c, i) => (
              <span
                key={i}
                style={{ width: 14, height: 6, background: c, borderRadius: 1 }}
              />
            ))}
          </div>
        </div>
      )}

      {/* sheet / side panel */}
      <div style={{ ...sheetStyle(t, { maxH: "56%" }) }}>
        {!t.land && (
          <div
            style={{
              width: 42,
              height: 5,
              borderRadius: 9,
              background: t.faint,
              margin: "12px auto 0",
              flexShrink: 0,
            }}
          />
        )}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: t.land ? "14px 16px" : "12px 20px 110px",
          }}
        >
          {t.land && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              {["All", "Excellent", "Gravel", "Curvy 4+"].map((f) => (
                <Chip
                  key={f}
                  active={filter === f}
                  accent={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </Chip>
              ))}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <div style={{ flex: 1 }}>
              <Stamp>{road.road}</Stamp>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 22,
                  letterSpacing: -0.4,
                  marginTop: 4,
                }}
              >
                {road.name}
              </div>
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 11,
                  color: t.mute,
                  marginTop: 4,
                }}
              >
                {road.km} · {road.turns} · {road.peak}
              </div>
            </div>
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 40,
                  lineHeight: 1,
                  letterSpacing: -1.5,
                  color: QC[road.q - 1],
                }}
              >
                {road.q}
                <span style={{ fontSize: 15, color: t.faint }}>/5</span>
              </div>
              <div style={{ marginTop: 3 }}>
                <Stamp size={9}>{QFULL[road.q - 1]}</Stamp>
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: "11px 13px",
              borderRadius: t.rSm + 2,
              background: QC[road.q - 1] + "1f",
              border: "1px solid " + QC[road.q - 1] + "55",
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            {road.note}
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
            }}
          >
            {[
              [road.passes, "Passes", "phone"],
              [road.trend, "Trend 90d", "trend"],
              [road.hazards, "Hazards", "alert"],
            ].map(([v, l, ic]) => (
              <div
                key={l}
                style={{
                  padding: "11px 12px",
                  borderRadius: t.rSm,
                  background: t.raised2,
                  border: "1px solid " + t.line,
                }}
              >
                <Icon name={ic} size={15} color={t.mute} />
                <div
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 17,
                    marginTop: 6,
                  }}
                >
                  {v}
                </div>
                <Stamp size={9}>{l}</Stamp>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, marginBottom: 6 }}>
            <Stamp>Nearby segments</Stamp>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {EXPLORER_ROADS.map((r) => (
              <button
                key={r.id}
                onClick={() => setSel(r.id)}
                style={{
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 13px",
                  cursor: "pointer",
                  borderRadius: t.rSm + 2,
                  background: r.id === sel ? t.invBg : t.raised,
                  color: r.id === sel ? t.invFg : t.fg,
                  border:
                    "1px solid " + (r.id === sel ? "transparent" : t.line),
                }}
              >
                <div
                  style={{
                    width: 4,
                    alignSelf: "stretch",
                    borderRadius: 2,
                    background: QC[r.q - 1],
                    minHeight: 32,
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontFamily: t.sans,
                      fontWeight: 700,
                      fontSize: 13.5,
                    }}
                  >
                    {r.name}
                  </div>
                  <div
                    style={{
                      fontFamily: t.mono,
                      fontSize: 10.5,
                      color: r.id === sel ? "rgba(245,239,230,0.6)" : t.mute,
                      marginTop: 2,
                    }}
                  >
                    {r.road.split(" · ")[0]} · {r.km}
                  </div>
                </div>
                <QBars
                  q={r.q}
                  size={6}
                  empty={r.id === sel ? "rgba(245,239,230,0.18)" : undefined}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </Screen>
  );
}

Object.assign(window, { HomeScreen, ExplorerScreen, mapThemeFromCfg, Avatar });
