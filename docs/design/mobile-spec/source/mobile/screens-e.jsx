// screens-e.jsx — Auth (welcome / sign in / sign up) + Settings.

// ── Brand mark for auth ─────────────────────────────────────────
function BrandMark({ size = 46, light }) {
  const c = light ? "#F5EFE6" : "#0E0E10";
  return (
    <svg width={size} height={size} viewBox="0 0 26 26">
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
  );
}

function Field({
  label,
  value,
  placeholder,
  type,
  onDark,
  t,
  icon,
  rightSlot,
}) {
  return (
    <label style={{ display: "block" }}>
      <Stamp size={9}>{label}</Stamp>
      <div
        style={{
          marginTop: 7,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          height: 52,
          borderRadius: t.rSm + 3,
          background: onDark ? "rgba(255,255,255,0.06)" : t.raised,
          border: "1px solid " + (onDark ? t.invLine : t.line),
        }}
      >
        {icon && <Icon name={icon} size={18} color={t.mute} />}
        <span
          style={{
            flex: 1,
            fontFamily: t.sans,
            fontWeight: value ? 600 : 400,
            fontSize: 15,
            color: value ? t.fg : t.mute,
          }}
        >
          {value || placeholder}
        </span>
        {rightSlot}
      </div>
    </label>
  );
}

function SocialRow({ t, onDark }) {
  const btns = [
    {
      id: "apple",
      label: "Apple",
      glyph: (
        <path
          d="M16 12.6c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .6 1 1.4 2.1 2.4 2 1-.1 1.3-.6 2.5-.6s1.5.6 2.6.6 1.7-1 2.3-2c.7-1.1 1-2.2 1-2.3-.1 0-2-.8-2-3zM14.3 6.3c.5-.7.9-1.6.8-2.5-.8 0-1.7.5-2.3 1.2-.5.6-.9 1.5-.8 2.4.9.1 1.7-.4 2.3-1.1z"
          fill={onDark ? "#F3EEE6" : "#0E0E10"}
        />
      ),
    },
    {
      id: "google",
      label: "Google",
      glyph: (
        <>
          <path
            d="M21 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h5c-.2 1.1-.9 2.1-1.9 2.7v2.2h3C19.9 17.1 21 14.9 21 12.2z"
            fill="#4285F4"
          />
          <path
            d="M12 21c2.4 0 4.5-.8 6-2.2l-3-2.2c-.8.5-1.9.9-3 .9-2.3 0-4.3-1.6-5-3.7H3.9v2.3C5.4 19 8.5 21 12 21z"
            fill="#34A853"
          />
          <path
            d="M7 13.6c-.2-.5-.3-1.1-.3-1.6s.1-1.1.3-1.6V8.1H3.9C3.3 9.3 3 10.6 3 12s.3 2.7.9 3.9L7 13.6z"
            fill="#FBBC05"
          />
          <path
            d="M12 6.7c1.3 0 2.5.5 3.4 1.3l2.6-2.6C16.5 3.9 14.4 3 12 3 8.5 3 5.4 5 3.9 8.1L7 10.4c.7-2.1 2.7-3.7 5-3.7z"
            fill="#EA4335"
          />
        </>
      ),
    },
  ];
  return (
    <div style={{ display: "flex", gap: 10 }}>
      {btns.map((b) => (
        <button
          key={b.id}
          style={{
            flex: 1,
            height: 52,
            borderRadius: t.rSm + 3,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            background: onDark ? "rgba(255,255,255,0.06)" : t.raised,
            border: "1px solid " + (onDark ? t.invLine : t.line),
            fontFamily: t.sans,
            fontWeight: 700,
            fontSize: 14.5,
            color: t.fg,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            {b.glyph}
          </svg>
          {b.label}
        </button>
      ))}
    </div>
  );
}

// ── AUTH (welcome → signin → signup) ────────────────────────────
function AuthScreen({ cfg, onAuthed, initial = "welcome" }) {
  const t = useT();
  const [view, setView] = React.useState(initial);
  const onDark = t.dark;

  if (view === "welcome") {
    // Full-bleed dark hero over the map — always immersive
    return (
      <Screen bg="#0B0C0F" onDark>
        <div style={{ position: "absolute", inset: 0 }}>
          <TarmotoMap
            theme="dark"
            mapStyle="heatmap"
            progress={62}
            accent={t.accent}
            showLabels={false}
          />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(to bottom, rgba(11,12,15,0.5) 0%, rgba(11,12,15,0.2) 38%, rgba(11,12,15,0.92) 78%)",
          }}
        />
        <StatusBar onDark />
        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            padding: t.land ? "0 40px 30px" : "0 26px 34px",
            zIndex: 2,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              marginBottom: t.land ? 14 : 18,
            }}
          >
            <BrandMark size={34} light />
            <span
              style={{
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 22,
                letterSpacing: -0.5,
                color: "#F5EFE6",
              }}
            >
              Tarmoto
            </span>
          </div>
          <div
            style={{
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: t.land ? 38 : 44,
              lineHeight: 1.0,
              letterSpacing: -1.4,
              color: "#F5EFE6",
              maxWidth: 440,
            }}
          >
            Know the road
            <br />
            before you ride it.
          </div>
          <div
            style={{
              fontSize: 15,
              color: "rgba(245,239,230,0.72)",
              marginTop: 14,
              lineHeight: 1.45,
              maxWidth: 360,
            }}
          >
            Live road-quality maps built from riders’ sensors. Find the good
            tarmac, dodge the bad.
          </div>
          <div
            style={{
              marginTop: 24,
              display: "flex",
              flexDirection: "column",
              gap: 11,
              maxWidth: t.land ? 420 : "none",
            }}
          >
            <Btn
              accent
              onClick={() => setView("signup")}
              size="lg"
              icon={<Icon name="bolt" size={19} color="#0E0E10" sw={2} />}
            >
              Create account
            </Btn>
            <button
              onClick={() => setView("signin")}
              style={{
                width: "100%",
                padding: 16,
                borderRadius: 14,
                cursor: "pointer",
                background: "rgba(255,255,255,0.08)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#F5EFE6",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 16,
              }}
            >
              I already ride with Tarmoto
            </button>
          </div>
          <div
            style={{
              marginTop: 18,
              textAlign: "center",
              fontFamily: t.mono,
              fontSize: 10.5,
              color: "rgba(245,239,230,0.5)",
              lineHeight: 1.5,
            }}
          >
            By continuing you agree to our Terms & Privacy Policy
          </div>
        </div>
      </Screen>
    );
  }

  const isSignup = view === "signup";
  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <TopBar title="" onBack={() => setView("welcome")} onDark={onDark} />
      <Scroll pad={26} bottomPad={30}>
        <div style={{ maxWidth: t.land ? 460 : "none", margin: "0 auto" }}>
          <BrandMark size={40} light={onDark} />
          <div
            style={{
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: -0.7,
              marginTop: 18,
            }}
          >
            {isSignup ? "Create your account" : "Welcome back"}
          </div>
          <div style={{ fontSize: 14, color: t.dim, marginTop: 6 }}>
            {isSignup
              ? "Start mapping the roads you ride."
              : "Pick up where you left off."}
          </div>

          <div
            style={{
              marginTop: 24,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {isSignup && (
              <Field
                label="Name"
                value="Luca Moretti"
                type="text"
                icon="user"
                onDark={onDark}
                t={t}
              />
            )}
            <Field
              label="Email"
              value="luca@moretti.cc"
              type="email"
              icon="pin"
              onDark={onDark}
              t={t}
            />
            <Field
              label="Password"
              value="••••••••••"
              type="password"
              icon="settings"
              onDark={onDark}
              t={t}
              rightSlot={
                <Stamp size={9} color={t.accent}>
                  {isSignup ? "STRONG" : "SHOW"}
                </Stamp>
              }
            />
          </div>

          {!isSignup && (
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <Stamp size={10} color={t.dim}>
                Forgot password?
              </Stamp>
            </div>
          )}

          <div style={{ marginTop: 22 }}>
            <Btn
              accent
              onDark={onDark}
              size="lg"
              onClick={onAuthed}
              icon={<Icon name="nav" size={18} color="#0E0E10" sw={2} />}
            >
              {isSignup ? "Create account" : "Sign in"}
            </Btn>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "22px 0",
            }}
          >
            <div style={{ flex: 1, height: 1, background: t.line }} />
            <Stamp size={9} color={t.mute}>
              or continue with
            </Stamp>
            <div style={{ flex: 1, height: 1, background: t.line }} />
          </div>
          <SocialRow t={t} onDark={onDark} />

          <div
            style={{
              marginTop: 26,
              textAlign: "center",
              fontFamily: t.sans,
              fontSize: 14,
              color: t.dim,
            }}
          >
            {isSignup ? "Already have an account? " : "New to Tarmoto? "}
            <button
              onClick={() => setView(isSignup ? "signin" : "signup")}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
                color: t.accent,
                padding: 0,
              }}
            >
              {isSignup ? "Sign in" : "Create one"}
            </button>
          </div>
        </div>
      </Scroll>
    </Screen>
  );
}

// ── SETTINGS ────────────────────────────────────────────────────
function Toggle({ on, onClick, t }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 46,
        height: 28,
        borderRadius: 999,
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        background: on
          ? t.accent
          : t.dark
            ? "rgba(243,238,230,0.18)"
            : "rgba(14,14,16,0.16)",
        padding: 3,
        display: "flex",
        justifyContent: on ? "flex-end" : "flex-start",
        transition: "all 160ms",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

function SettingsScreen({ cfg, onBack }) {
  const t = useT();
  const onDark = t.dark;
  const [tog, setTog] = React.useState({
    crash: true,
    hazardAlerts: true,
    voice: true,
    autopause: true,
    offline: false,
    share: true,
  });
  const flip = (k) => setTog((s) => ({ ...s, [k]: !s[k] }));

  const Section = ({ label, children }) => (
    <div style={{ marginTop: 22 }}>
      <div style={{ marginBottom: 9, paddingLeft: 2 }}>
        <Stamp>{label}</Stamp>
      </div>
      <Card raised pad={0} style={{ overflow: "hidden" }}>
        {children}
      </Card>
    </div>
  );
  const Row = ({ icon, title, sub, right, last, danger }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "14px 16px",
        borderBottom: last ? "none" : "1px solid " + t.line,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          flexShrink: 0,
          background: danger
            ? QC[0] + "22"
            : onDark
              ? "rgba(255,255,255,0.06)"
              : t.bg,
          border: "1px solid " + (danger ? QC[0] + "55" : t.line),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={18} color={danger ? QC[0] : t.dim} />
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 600,
            fontSize: 15,
            color: danger ? QC[0] : t.fg,
          }}
        >
          {title}
        </div>
        {sub && (
          <div
            style={{
              fontFamily: t.mono,
              fontSize: 11,
              color: t.mute,
              marginTop: 2,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {right}
    </div>
  );
  const Chev = <Icon name="right" size={17} color={t.faint} />;

  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <TopBar title="Settings" onBack={onBack} onDark={onDark} />
      <Scroll pad={20} bottomPad={120}>
        {/* account header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "6px 4px 2px",
          }}
        >
          <Avatar size={56} />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 19,
                letterSpacing: -0.3,
              }}
            >
              Luca Moretti
            </div>
            <div
              style={{
                fontFamily: t.mono,
                fontSize: 11.5,
                color: t.mute,
                marginTop: 2,
              }}
            >
              luca@moretti.cc
            </div>
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 11px",
              borderRadius: 999,
              background: t.invBg,
              color: t.invFg,
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: 11,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 9,
                background: t.accent,
              }}
            />{" "}
            PRO
          </div>
        </div>

        <Section label="Safety">
          <Row
            icon="heart"
            title="Crash detection"
            sub="Auto-alert contacts after a hard impact"
            right={
              <Toggle on={tog.crash} onClick={() => flip("crash")} t={t} />
            }
          />
          <Row
            icon="alert"
            title="Hazard alerts"
            sub="Warn me about hazards ahead"
            right={
              <Toggle
                on={tog.hazardAlerts}
                onClick={() => flip("hazardAlerts")}
                t={t}
              />
            }
          />
          <Row
            icon="user"
            title="Emergency contacts"
            sub="Elena · Dani"
            right={Chev}
            last
          />
        </Section>

        <Section label="Navigation & ride">
          <Row
            icon="speed"
            title="Voice guidance"
            sub="Spoken turn-by-turn"
            right={
              <Toggle on={tog.voice} onClick={() => flip("voice")} t={t} />
            }
          />
          <Row
            icon="clock"
            title="Auto-pause"
            sub="Pause tracking when stopped"
            right={
              <Toggle
                on={tog.autopause}
                onClick={() => flip("autopause")}
                t={t}
              />
            }
          />
          <Row icon="gauge" title="Units" sub="Metric · km, °C" right={Chev} />
          <Row
            icon="route"
            title="Avoid by default"
            sub="Highways, tolls"
            right={Chev}
            last
          />
        </Section>

        <Section label="Data & maps">
          <Row
            icon="layers"
            title="Offline maps"
            sub="Download regions for no-signal rides"
            right={
              <Toggle on={tog.offline} onClick={() => flip("offline")} t={t} />
            }
          />
          <Row
            icon="share"
            title="Share my road data"
            sub="Help improve quality maps"
            right={
              <Toggle on={tog.share} onClick={() => flip("share")} t={t} />
            }
          />
          <Row
            icon="trend"
            title="Storage"
            sub="1.2 GB cached"
            right={Chev}
            last
          />
        </Section>

        <Section label="Account">
          <Row icon="settings" title="Personal details" right={Chev} />
          <Row
            icon="phone"
            title="Linked devices"
            sub="2 connected"
            right={Chev}
          />
          <Row
            icon="bolt"
            title="Manage subscription"
            sub="Tarmoto Pro · renews May 4"
            right={Chev}
            last
          />
        </Section>

        <div style={{ marginTop: 22 }}>
          <Card raised pad={0} style={{ overflow: "hidden" }}>
            <Row icon="left" title="Sign out" right={Chev} last />
          </Card>
        </div>

        <div style={{ marginTop: 18, textAlign: "center" }}>
          <Stamp size={10} color={t.mute}>
            Tarmoto 2.4.0 · build 1840
          </Stamp>
        </div>
      </Scroll>
    </Screen>
  );
}

Object.assign(window, { AuthScreen, SettingsScreen });
