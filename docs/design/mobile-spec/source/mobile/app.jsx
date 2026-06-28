// app.jsx — top-level: router, control rail, gallery, tweaks wiring.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  direction: "atlas",
  theme: "light",
  mapStyle: "dark",
  homeLayout: "map",
  navStyle: "bar",
  orient: "portrait",
}; /*EDITMODE-END*/

const SCENES = [
  { id: "auth", label: "Welcome / sign in", nav: false },
  { id: "signup", label: "Sign up", nav: false },
  { id: "home", label: "Home", nav: true },
  { id: "plan", label: "Quick planner", nav: true },
  { id: "route", label: "Generated route", nav: true },
  { id: "roads", label: "Road explorer", nav: true },
  { id: "ride", label: "Ride mode", nav: false },
  { id: "hazard", label: "Hazard report", nav: false },
  { id: "crash", label: "Crash detection", nav: false },
  { id: "postride", label: "Post-ride summary", nav: false },
  { id: "me", label: "Profile", nav: true },
  { id: "settings", label: "Settings", nav: false },
];

function navTabFor(id) {
  if (id === "plan" || id === "route") return "plan";
  if (id === "roads") return "roads";
  if (id === "me") return "me";
  return "home";
}

function Wordmark({ dark }) {
  const c = dark ? "#F3EEE6" : "#0E0E10";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <svg width="26" height="26" viewBox="0 0 26 26">
        <path
          d="M3 21 13 5l10 16H3Z"
          fill="none"
          stroke={c}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 21 13 15l3.5 6"
          fill="none"
          stroke="#FF6A1A"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      </svg>
      <div
        style={{
          fontFamily: "'Space Grotesk', system-ui",
          fontWeight: 800,
          fontSize: 19,
          letterSpacing: -0.5,
          color: c,
        }}
      >
        Tarmoto
      </div>
    </div>
  );
}

function RailSeg({ options, value, onChange, dark }) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 3,
        padding: 3,
        borderRadius: 11,
        background: dark ? "rgba(255,255,255,0.06)" : "rgba(14,14,16,0.05)",
        border:
          "1px solid " +
          (dark ? "rgba(255,255,255,0.08)" : "rgba(14,14,16,0.08)"),
      }}
    >
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              padding: "7px 13px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              fontFamily: "'Space Grotesk', system-ui",
              fontWeight: 700,
              fontSize: 12.5,
              background: on ? (dark ? "#F3EEE6" : "#0E0E10") : "transparent",
              color: on
                ? dark
                  ? "#0E0E10"
                  : "#F5EFE6"
                : dark
                  ? "rgba(243,238,230,0.65)"
                  : "rgba(14,14,16,0.55)",
              transition: "all 140ms",
            }}
          >
            {o.l}
          </button>
        );
      })}
    </div>
  );
}

function PhoneScene({
  name,
  cfg,
  handlers,
  scale = 1,
  interactive = true,
  tab,
  onTab,
  onStart,
}) {
  const t = useT();
  const immersive = name === "ride" || name === "crash";
  const frameDark = immersive ? true : t.dark;
  let screen;
  if (name === "home")
    screen = (
      <HomeScreen
        cfg={cfg}
        onStart={handlers.start}
        onOpenRide={handlers.start}
      />
    );
  else if (name === "roads") screen = <ExplorerScreen cfg={cfg} />;
  else if (name === "ride")
    screen = (
      <RideScreen cfg={cfg} onReport={handlers.report} onEnd={handlers.end} />
    );
  else if (name === "hazard")
    screen = (
      <HazardScreen onBack={handlers.toRide} onSubmit={handlers.toRide} />
    );
  else if (name === "crash")
    screen = <CrashScreen onCancel={handlers.toRide} />;
  else if (name === "postride")
    screen = <PostRideScreen onDone={handlers.home} onShare={handlers.home} />;
  else if (name === "plan")
    screen = interactive ? (
      <PlannerScreen cfg={cfg} onStart={handlers.start} />
    ) : (
      <QuickPlanScreen embedded onGenerate={() => {}} />
    );
  else if (name === "route")
    screen = (
      <RouteResultScreen
        cfg={cfg}
        embedded
        onBack={() => {}}
        onStart={handlers.start}
        onShuffle
      />
    );
  else if (name === "me")
    screen = <ProfileScreen cfg={cfg} onSettings={handlers.settings} />;
  else if (name === "auth")
    screen = (
      <AuthScreen cfg={cfg} initial="welcome" onAuthed={handlers.home} />
    );
  else if (name === "signup")
    screen = <AuthScreen cfg={cfg} initial="signup" onAuthed={handlers.home} />;
  else if (name === "settings")
    screen = <SettingsScreen cfg={cfg} onBack={handlers.me} />;

  const showNav = SCENES.find((s) => s.id === name)?.nav;
  return (
    <Phone onDark={frameDark} scale={scale}>
      {screen}
      {showNav && (
        <NavBar
          style={cfg.navStyle}
          active={tab}
          onDark={t.dark}
          onTab={interactive ? onTab : () => {}}
          onStart={interactive ? onStart : () => {}}
        />
      )}
      <HomeIndicator onDark={frameDark} />
    </Phone>
  );
}

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const cfg = tw;
  const tokens = React.useMemo(
    () => resolveTokens(cfg),
    [cfg.direction, cfg.theme, cfg.orient],
  );
  const [mode, setMode] = React.useState("proto");
  const [tab, setTab] = React.useState("home");
  const [overlay, setOverlay] = React.useState(null);
  const dark = tokens.dark;

  const setDirection = (v) => {
    // sensible default theme per direction; user can still flip
    setTweak({ direction: v, theme: v === "onyx" ? "dark" : "light" });
  };

  const handlers = {
    start: () => setOverlay("ride"),
    report: () => setOverlay("hazard"),
    end: () => setOverlay("postride"),
    toRide: () => setOverlay("ride"),
    home: () => {
      setOverlay(null);
      setTab("home");
    },
    settings: () => setOverlay("settings"),
    me: () => {
      setOverlay(null);
      setTab("me");
    },
  };
  const onTab = (id) => {
    setOverlay(null);
    setTab(id);
  };
  const current = overlay || tab;

  const stageBg = dark ? "#0E0F12" : "#E4DBCC";
  const railBg = dark ? "rgba(18,19,23,0.9)" : "rgba(245,239,230,0.92)";
  const railLine = dark ? "rgba(243,238,230,0.1)" : "rgba(14,14,16,0.1)";

  const scenarios = [
    { id: "auth", label: "Sign in", ic: "user" },
    { id: "ride", label: "Ride mode", ic: "nav" },
    { id: "hazard", label: "Report", ic: "alert" },
    { id: "crash", label: "Crash", ic: "heart" },
    { id: "postride", label: "Summary", ic: "flag" },
    { id: "settings", label: "Settings", ic: "settings" },
  ];

  return (
    <TokenCtx.Provider value={tokens}>
      <div
        style={{
          minHeight: "100vh",
          background: stageBg,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* control rail */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 50,
            background: railBg,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: "1px solid " + railLine,
            padding: "14px 22px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            flexWrap: "wrap",
          }}
        >
          <Wordmark dark={dark} />
          <div style={{ width: 1, height: 26, background: railLine }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: dark ? "rgba(243,238,230,0.45)" : "rgba(14,14,16,0.42)",
              }}
            >
              Look
            </span>
            <RailSeg
              dark={dark}
              value={cfg.direction}
              onChange={setDirection}
              options={[
                { v: "atlas", l: "Atlas" },
                { v: "onyx", l: "Onyx" },
                { v: "rally", l: "Rally" },
              ]}
            />
          </div>
          <button
            onClick={() => setTweak("theme", dark ? "light" : "dark")}
            title="Toggle theme"
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid " + railLine,
              background: dark
                ? "rgba(255,255,255,0.06)"
                : "rgba(14,14,16,0.04)",
              color: dark ? "#F3EEE6" : "#0E0E10",
            }}
          >
            <Icon name={dark ? "sun" : "moon"} size={19} />
          </button>
          <button
            onClick={() =>
              setTweak(
                "orient",
                cfg.orient === "landscape" ? "portrait" : "landscape",
              )
            }
            title="Rotate device"
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid " + railLine,
              background:
                cfg.orient === "landscape"
                  ? "#FF6A1A"
                  : dark
                    ? "rgba(255,255,255,0.06)"
                    : "rgba(14,14,16,0.04)",
              color:
                cfg.orient === "landscape"
                  ? "#0E0E10"
                  : dark
                    ? "#F3EEE6"
                    : "#0E0E10",
            }}
          >
            <Icon
              name="phone"
              size={19}
              style={{
                transform:
                  cfg.orient === "landscape" ? "rotate(90deg)" : "none",
              }}
            />
          </button>

          <div style={{ flex: 1 }} />

          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9.5,
              color: dark ? "rgba(243,238,230,0.4)" : "rgba(14,14,16,0.4)",
              letterSpacing: 0.5,
              maxWidth: 190,
              lineHeight: 1.4,
              display: "none",
            }}
            className="rail-hint"
          >
            Open Tweaks for map · home · nav
          </span>
          <RailSeg
            dark={dark}
            value={mode}
            onChange={setMode}
            options={[
              { v: "proto", l: "Prototype" },
              { v: "gallery", l: "Gallery" },
            ]}
          />
        </div>

        {/* scenario quick-launch (proto only) */}
        {mode === "proto" && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 8,
              padding: "14px 22px 2px",
              flexWrap: "wrap",
            }}
          >
            {scenarios.map((s) => {
              const on = overlay === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setOverlay(s.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 14px",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontFamily: "'Space Grotesk', system-ui",
                    fontWeight: 700,
                    fontSize: 12.5,
                    border: "1px solid " + (on ? "transparent" : railLine),
                    background: on
                      ? "#FF6A1A"
                      : dark
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(255,255,255,0.5)",
                    color: on ? "#0E0E10" : dark ? "#F3EEE6" : "#0E0E10",
                  }}
                >
                  <Icon
                    name={s.ic}
                    size={15}
                    color={on ? "#0E0E10" : dark ? "#F3EEE6" : "#0E0E10"}
                  />{" "}
                  {s.label}
                </button>
              );
            })}
            {overlay && (
              <button
                onClick={() => setOverlay(null)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 14px",
                  borderRadius: 999,
                  cursor: "pointer",
                  fontFamily: "'Space Grotesk', system-ui",
                  fontWeight: 700,
                  fontSize: 12.5,
                  border: "1px solid " + railLine,
                  background: "transparent",
                  color: dark ? "rgba(243,238,230,0.6)" : "rgba(14,14,16,0.55)",
                }}
              >
                <Icon
                  name="close"
                  size={14}
                  color={dark ? "rgba(243,238,230,0.6)" : "rgba(14,14,16,0.55)"}
                />{" "}
                Exit
              </button>
            )}
          </div>
        )}

        {/* stage */}
        {mode === "proto" ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              padding: "28px 20px 60px",
            }}
          >
            <PhoneScene
              name={current}
              cfg={cfg}
              handlers={handlers}
              tab={tab}
              onTab={onTab}
              onStart={handlers.start}
            />
          </div>
        ) : (
          <div style={{ flex: 1, padding: "30px 28px 80px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(auto-fill, minmax(${cfg.orient === "landscape" ? 366 : 258}px, 1fr))`,
                gap: "36px 24px",
                maxWidth: 1280,
                margin: "0 auto",
                justifyItems: "center",
              }}
            >
              {SCENES.map((sc) => (
                <div
                  key={sc.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  <PhoneScene
                    name={sc.id}
                    cfg={cfg}
                    handlers={handlers}
                    tab={navTabFor(sc.id)}
                    interactive={false}
                    scale={cfg.orient === "landscape" ? 0.42 : 0.62}
                  />
                  <div style={{ textAlign: "center" }}>
                    <div
                      style={{
                        fontFamily: "'Space Grotesk', system-ui",
                        fontWeight: 800,
                        fontSize: 14,
                        color: dark ? "#F3EEE6" : "#0E0E10",
                      }}
                    >
                      {sc.label}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tweaks */}
        <TweaksPanel title="Tweaks">
          <TweakSection label="Look & feel" />
          <TweakRadio
            label="Direction"
            value={cfg.direction}
            options={["atlas", "onyx", "rally"]}
            onChange={setDirection}
          />
          <TweakRadio
            label="Theme"
            value={cfg.theme}
            options={["light", "dark"]}
            onChange={(v) => setTweak("theme", v)}
          />
          <TweakSection label="Map & layout" />
          <TweakRadio
            label="Map style"
            value={cfg.mapStyle}
            options={["light", "dark"]}
            onChange={(v) => setTweak("mapStyle", v)}
          />
          <TweakRadio
            label="Home"
            value={cfg.homeLayout}
            options={["map", "list"]}
            onChange={(v) => setTweak("homeLayout", v)}
          />
          <TweakRadio
            label="Bottom nav"
            value={cfg.navStyle}
            options={["bar", "dock", "float"]}
            onChange={(v) => setTweak("navStyle", v)}
          />
          <TweakRadio
            label="Orientation"
            value={cfg.orient}
            options={["portrait", "landscape"]}
            onChange={(v) => setTweak("orient", v)}
          />
        </TweaksPanel>
      </div>
    </TokenCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
