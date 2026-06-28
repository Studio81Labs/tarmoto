// screens-d.jsx — Calimoto-style quick round-trip planner: generator + result.

// ── Direction wheel ─────────────────────────────────────────────
const DIRS = [
  { id: "N", a: -90 },
  { id: "NE", a: -45 },
  { id: "E", a: 0 },
  { id: "SE", a: 45 },
  { id: "S", a: 90 },
  { id: "SW", a: 135 },
  { id: "W", a: 180 },
  { id: "NW", a: -135 },
];
function DirectionWheel({ value, onChange, onDark }) {
  const t = useT();
  const S = 170,
    c = S / 2,
    r = 64;
  const line = onDark ? t.invLine : t.line;
  const sel = DIRS.find((d) => d.id === value);
  return (
    <div
      style={{ position: "relative", width: S, height: S, margin: "0 auto" }}
    >
      <svg
        width={S}
        height={S}
        viewBox={`0 0 ${S} ${S}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={line}
          strokeWidth="1.5"
        />
        <circle
          cx={c}
          cy={c}
          r={r + 14}
          fill="none"
          stroke={line}
          strokeWidth="1"
          strokeDasharray="2 5"
          opacity="0.6"
        />
        {sel && (
          <line
            x1={c}
            y1={c}
            x2={c + Math.cos((sel.a * Math.PI) / 180) * r}
            y2={c + Math.sin((sel.a * Math.PI) / 180) * r}
            stroke={t.accent}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        )}
      </svg>
      {DIRS.map((d) => {
        const on = value === d.id;
        const x = c + Math.cos((d.a * Math.PI) / 180) * r,
          y = c + Math.sin((d.a * Math.PI) / 180) * r;
        return (
          <button
            key={d.id}
            onClick={() => onChange(d.id)}
            style={{
              position: "absolute",
              left: x - 17,
              top: y - 17,
              width: 34,
              height: 34,
              borderRadius: 999,
              cursor: "pointer",
              background: on
                ? t.accent
                : onDark
                  ? "rgba(255,255,255,0.06)"
                  : t.raised,
              color: on ? "#0E0E10" : t.dim,
              border: "1px solid " + (on ? "transparent" : line),
              fontFamily: t.mono,
              fontWeight: 700,
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {d.id}
          </button>
        );
      })}
      <button
        onClick={() => onChange("any")}
        style={{
          position: "absolute",
          left: c - 30,
          top: c - 30,
          width: 60,
          height: 60,
          borderRadius: 999,
          cursor: "pointer",
          background:
            value === "any"
              ? t.fg
              : onDark
                ? "rgba(255,255,255,0.05)"
                : t.raised2,
          color: value === "any" ? t.bg : t.dim,
          border: "1px solid " + line,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <Icon
          name="nav"
          size={18}
          color={value === "any" ? t.bg : t.dim}
          sw={2}
        />
        <span
          style={{
            fontFamily: t.mono,
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          ANY
        </span>
      </button>
    </div>
  );
}

// ── Notched level selector (curviness) ──────────────────────────
function LevelPicker({ value, onChange, labels, onDark }) {
  const t = useT();
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {labels.map((lab, i) => {
        const on = value === i;
        const reached = i <= value;
        return (
          <button
            key={i}
            onClick={() => onChange(i)}
            style={{
              flex: 1,
              padding: "10px 4px",
              borderRadius: t.rSm,
              cursor: "pointer",
              textAlign: "center",
              background: reached
                ? t.accent + (on ? "ff" : "26")
                : onDark
                  ? t.raised
                  : t.raised,
              border:
                "1px solid " + (on ? t.accent : onDark ? t.invLine : t.line),
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 2,
                marginBottom: 5,
              }}
            >
              {Array.from({ length: i + 1 }).map((_, k) => (
                <span
                  key={k}
                  style={{
                    width: 2.5,
                    height: 9 + k * 2,
                    borderRadius: 2,
                    background: on ? "#0E0E10" : reached ? t.accent : t.faint,
                  }}
                />
              ))}
            </div>
            <span
              style={{
                fontFamily: t.sans,
                fontWeight: 700,
                fontSize: 10.5,
                color: on ? "#0E0E10" : t.dim,
              }}
            >
              {lab}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── QUICK PLAN (generator) ──────────────────────────────────────
function QuickPlanScreen({ onGenerate, embedded }) {
  const t = useT();
  const onDark = t.dark;
  const [dur, setDur] = React.useState(1); // index into DURS
  const [heading, setHeading] = React.useState("NE");
  const [twist, setTwist] = React.useState(3);
  const [avoid, setAvoid] = React.useState({
    highways: true,
    paved: true,
    tolls: false,
  });
  const DURS = [
    ["1 h", "~48 km"],
    ["2 h", "~95 km"],
    ["3 h", "~150 km"],
    ["Half day", "~230 km"],
  ];
  const tog = (k) => setAvoid((a) => ({ ...a, [k]: !a[k] }));

  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <div
        style={{
          padding: t.land
            ? "6px 20px 4px " + (LAND_RAIL + 36) + "px"
            : "6px 20px 4px",
          flexShrink: 0,
        }}
      >
        <Stamp>Quick ride</Stamp>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: t.h1,
            letterSpacing: t.track,
            marginTop: 2,
          }}
        >
          Round trip
        </div>
        <div style={{ fontSize: 13, color: t.dim, marginTop: 4 }}>
          A loop from here, back to here — built around good tarmac.
        </div>
      </div>
      <Scroll pad={20} bottomPad={110}>
        {/* start point */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "13px 14px",
            borderRadius: t.rSm + 2,
            background: onDark ? t.raised : t.raised2,
            border: "1px solid " + t.line,
            marginTop: 4,
          }}
        >
          <Icon name="pin" size={20} color={t.accent} />
          <div style={{ flex: 1 }}>
            <Stamp size={9}>Start & finish</Stamp>
            <div
              style={{
                fontFamily: t.sans,
                fontWeight: 700,
                fontSize: 14,
                marginTop: 2,
              }}
            >
              Current location · Bolzano
            </div>
          </div>
          <Icon name="settings" size={18} color={t.faint} />
        </div>

        {/* how long */}
        <div style={{ marginTop: 20 }}>
          <Stamp>How long do you have?</Stamp>
          <div
            style={{
              marginTop: 9,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            {DURS.map(([lab, km], i) => {
              const on = dur === i;
              return (
                <button
                  key={lab}
                  onClick={() => setDur(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 16px",
                    cursor: "pointer",
                    borderRadius: t.r,
                    background: on ? t.fg : onDark ? t.raised : t.raised,
                    color: on ? t.bg : t.fg,
                    border: "1px solid " + (on ? "transparent" : t.line),
                  }}
                >
                  <span
                    style={{
                      fontFamily: t.sans,
                      fontWeight: 800,
                      fontSize: 16,
                    }}
                  >
                    {lab}
                  </span>
                  <span
                    style={{
                      fontFamily: t.mono,
                      fontSize: 11,
                      color: on ? "rgba(245,239,230,0.65)" : t.mute,
                    }}
                  >
                    {km}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* direction */}
        <div style={{ marginTop: 22 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <Stamp>Which way?</Stamp>
            <Stamp size={9} color={t.accent}>
              {heading === "any" ? "Surprise me" : "Head " + heading}
            </Stamp>
          </div>
          <div style={{ marginTop: 12 }}>
            <DirectionWheel
              value={heading}
              onChange={setHeading}
              onDark={onDark}
            />
          </div>
        </div>

        {/* curviness */}
        <div style={{ marginTop: 18 }}>
          <Stamp>Curviness</Stamp>
          <div style={{ marginTop: 9 }}>
            <LevelPicker
              value={twist}
              onChange={setTwist}
              onDark={onDark}
              labels={["Mellow", "Easy", "Mixed", "Twisty", "Wild"]}
            />
          </div>
        </div>

        {/* avoid */}
        <div style={{ marginTop: 20 }}>
          <Stamp>Avoid</Stamp>
          <div
            style={{ marginTop: 9, display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <Chip
              active={avoid.highways}
              accent={avoid.highways}
              dark={onDark}
              onClick={() => tog("highways")}
            >
              No highways
            </Chip>
            <Chip
              active={avoid.paved}
              accent={avoid.paved}
              dark={onDark}
              onClick={() => tog("paved")}
            >
              Paved only
            </Chip>
            <Chip
              active={avoid.tolls}
              accent={avoid.tolls}
              dark={onDark}
              onClick={() => tog("tolls")}
            >
              Avoid tolls
            </Chip>
          </div>
        </div>
      </Scroll>

      {/* sticky generate */}
      <div
        style={{
          position: "absolute",
          left: t.land ? LAND_RAIL + 24 : 0,
          right: 0,
          bottom: 0,
          padding: "14px 20px",
          paddingBottom: t.land ? 16 : embedded ? 100 : 34,
          background: `linear-gradient(to top, ${t.bg} 62%, transparent)`,
          zIndex: 20,
        }}
      >
        <div style={{ maxWidth: t.land ? 660 : "none", margin: "0 auto" }}>
          <Btn
            accent
            onDark={onDark}
            size="lg"
            onClick={() => onGenerate({ dur, heading, twist })}
            icon={<Icon name="bolt" size={19} color="#0E0E10" sw={2} />}
          >
            Generate loop
          </Btn>
        </div>
      </div>
    </Screen>
  );
}

// ── ROUTE RESULT (generated loop) ───────────────────────────────
const ROUTE_VARIANTS = [
  {
    id: 0,
    name: "Dolomiti quick loop",
    km: 95,
    dur: "2h 10m",
    turns: 64,
    elev: "+1,420 m",
    twist: 4,
    q: 4,
    prog: 35,
    zones: [
      ["Passo Pinei", 5],
      ["Val Gardena ridge", 4],
      ["Renon switchbacks", 3],
    ],
  },
  {
    id: 1,
    name: "Eggental twister",
    km: 88,
    dur: "2h 02m",
    turns: 78,
    elev: "+1,610 m",
    twist: 5,
    q: 3,
    prog: 60,
    zones: [
      ["Karerpass", 4],
      ["Nigerpass", 5],
      ["Eggental gorge", 3],
    ],
  },
  {
    id: 2,
    name: "Adige valley cruise",
    km: 102,
    dur: "2h 16m",
    turns: 41,
    elev: "+780 m",
    twist: 2,
    q: 5,
    prog: 20,
    zones: [
      ["Mendola climb", 4],
      ["Lake Caldaro", 5],
    ],
  },
];

function RouteResultScreen({ cfg, onBack, onStart, onShuffle, embedded }) {
  const t = useT();
  const [v, setV] = React.useState(0);
  const r = ROUTE_VARIANTS[v];
  const mapDark = mapThemeFromCfg(cfg) !== "light";
  return (
    <Screen onDark>
      <div
        style={{
          position: "absolute",
          inset: 0,
          ...(t.land ? {} : { height: "46%" }),
        }}
      >
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <TarmotoMap
            theme={mapThemeFromCfg(cfg)}
            mapStyle="heatmap"
            progress={r.prog}
            accent={t.accent}
            showLabels={false}
          />
        </div>
      </div>
      <StatusBar onDark={mapDark} />
      {!t.land && (
        <div style={{ position: "absolute", top: 50, left: 16, zIndex: 14 }}>
          <button
            onClick={onBack}
            style={{
              width: 42,
              height: 42,
              borderRadius: 999,
              border: "none",
              cursor: "pointer",
              background: mapDark
                ? "rgba(14,14,16,0.55)"
                : "rgba(245,239,230,0.85)",
              backdropFilter: "blur(12px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: mapDark ? "#F5EFE6" : "#0E0E10",
              boxShadow: "0 6px 18px rgba(14,14,16,0.2)",
            }}
          >
            <Icon name="left" size={21} />
          </button>
        </div>
      )}
      {/* variant tabs */}
      {!t.land && (
        <div
          style={{
            position: "absolute",
            top: 52,
            right: 16,
            zIndex: 14,
            display: "flex",
            gap: 6,
          }}
        >
          {ROUTE_VARIANTS.map((rv, i) => (
            <button
              key={i}
              onClick={() => setV(i)}
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                cursor: "pointer",
                border: "none",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
                background:
                  v === i
                    ? t.accent
                    : mapDark
                      ? "rgba(14,14,16,0.55)"
                      : "rgba(245,239,230,0.85)",
                color: v === i ? "#0E0E10" : mapDark ? "#F5EFE6" : "#0E0E10",
                backdropFilter: "blur(12px)",
              }}
            >
              {String.fromCharCode(65 + i)}
            </button>
          ))}
        </div>
      )}

      {/* sheet / side panel */}
      <div style={{ ...sheetStyle(t, { maxH: "64%" }) }}>
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
            overflowY: "auto",
            padding: t.land
              ? "14px 16px 16px"
              : "12px 20px " + (embedded ? "110px" : "30px"),
          }}
        >
          {t.land && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <button
                onClick={onBack}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  border: "1px solid " + t.line,
                  background: t.raised,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: t.fg,
                  flexShrink: 0,
                }}
              >
                <Icon name="left" size={19} />
              </button>
              <div style={{ flex: 1 }} />
              {ROUTE_VARIANTS.map((rv, i) => (
                <button
                  key={i}
                  onClick={() => setV(i)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    cursor: "pointer",
                    border: "none",
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 13,
                    background: v === i ? t.accent : t.raised2,
                    color: v === i ? "#0E0E10" : t.fg,
                  }}
                >
                  {String.fromCharCode(65 + i)}
                </button>
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
              <Stamp>Round trip · loop {String.fromCharCode(65 + v)}</Stamp>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 23,
                  letterSpacing: -0.5,
                  marginTop: 4,
                }}
              >
                {r.name}
              </div>
            </div>
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <div
                style={{ display: "flex", gap: 2, justifyContent: "center" }}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <span
                    key={n}
                    style={{
                      width: 4,
                      height: 14,
                      borderRadius: 2,
                      background: n <= r.twist ? t.accent : t.qEmpty,
                    }}
                  />
                ))}
              </div>
              <div style={{ marginTop: 4 }}>
                <Stamp size={9}>Twisty {r.twist}/5</Stamp>
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 8,
            }}
          >
            {[
              [r.km, "KM"],
              [r.dur, "TIME"],
              [r.turns, "TURNS"],
              [r.elev.replace(" m", ""), "M GAIN"],
            ].map(([val, l]) => (
              <div key={l}>
                <div
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 18,
                    lineHeight: 1,
                  }}
                >
                  {val}
                </div>
                <div style={{ marginTop: 4 }}>
                  <Stamp size={9}>{l}</Stamp>
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 14,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 13px",
              borderRadius: t.rSm + 2,
              background: t.raised2,
              border: "1px solid " + t.line,
            }}
          >
            <QBars q={r.q} size={7} />
            <div style={{ flex: 1, fontSize: 12.5 }}>
              <b>{QFULL[r.q - 1]} tarmac</b> overall · {r.zones.length} fun
              zones on this loop
            </div>
          </div>

          <div style={{ marginTop: 14, marginBottom: 8 }}>
            <Stamp>Fun zones</Stamp>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {r.zones.map(([name, q], i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 13px",
                  borderRadius: t.rSm + 2,
                  background: t.raised,
                  border: "1px solid " + t.line,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    background: t.bg,
                    border: "1px solid " + t.line,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontFamily: t.mono,
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  {i + 1}
                </div>
                <div
                  style={{
                    flex: 1,
                    fontFamily: t.sans,
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {name}
                </div>
                <QBars q={q} size={6} />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={() => onShuffle && setV((v + 1) % ROUTE_VARIANTS.length)}
              style={{
                flex: 1,
                padding: "14px",
                borderRadius: 14,
                cursor: "pointer",
                background: "transparent",
                color: t.fg,
                border: "1px solid " + t.lineStrong,
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="bolt" size={17} /> Shuffle
            </button>
            <div style={{ flex: 1.4 }}>
              <Btn
                accent
                onClick={onStart}
                icon={<Icon name="nav" size={18} color="#0E0E10" sw={2} />}
              >
                Start ride
              </Btn>
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}

// ── Interactive flow wrapper (Plan tab) ─────────────────────────
function PlannerScreen({ cfg, onStart }) {
  const [stage, setStage] = React.useState("form");
  if (stage === "result")
    return (
      <RouteResultScreen
        cfg={cfg}
        embedded
        onBack={() => setStage("form")}
        onStart={onStart}
        onShuffle
      />
    );
  return <QuickPlanScreen embedded onGenerate={() => setStage("result")} />;
}

Object.assign(window, {
  QuickPlanScreen,
  RouteResultScreen,
  PlannerScreen,
  DirectionWheel,
});
