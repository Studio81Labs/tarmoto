// chrome.jsx — device frame, status bar, 3 bottom-nav styles, shared layout helpers.

const SCREEN_W = 390;
const SCREEN_H = 844;

function StatusBar({ onDark, time = "9:41" }) {
  const t = useT();
  const c = onDark ? "#F3EEE6" : t.fg;
  return (
    <div
      style={{
        height: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 26px 0 30px",
        flexShrink: 0,
        position: "relative",
        zIndex: 30,
      }}
    >
      <span
        style={{
          fontFamily: t.sans,
          fontWeight: 700,
          fontSize: 15,
          color: c,
          letterSpacing: 0.2,
        }}
      >
        {time}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <svg width="18" height="12" viewBox="0 0 18 12">
          <g fill={c}>
            <rect x="0" y="7" width="3" height="5" rx="0.6" />
            <rect x="4.5" y="4.5" width="3" height="7.5" rx="0.6" />
            <rect x="9" y="2" width="3" height="10" rx="0.6" />
            <rect x="13.5" y="0" width="3" height="12" rx="0.6" />
          </g>
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path
            d="M8 3c2 0 3.8.8 5.2 2.1l1-1A9 9 0 0 0 8 1.4 9 9 0 0 0 1.8 4.1l1 1A7.4 7.4 0 0 1 8 3Z"
            fill={c}
          />
          <path
            d="M8 6.4c1.1 0 2.1.4 2.9 1.2l1-1A6 6 0 0 0 8 4.8a6 6 0 0 0-3.9 1.8l1 1A4.2 4.2 0 0 1 8 6.4Z"
            fill={c}
          />
          <circle cx="8" cy="10" r="1.4" fill={c} />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="22"
            height="11"
            rx="3"
            stroke={c}
            strokeOpacity="0.4"
          />
          <rect x="2" y="2" width="18" height="8" rx="1.6" fill={c} />
          <path
            d="M24 4v4c.7-.3 1.2-1 1.2-2S24.7 4.3 24 4Z"
            fill={c}
            fillOpacity="0.5"
          />
        </svg>
      </div>
    </div>
  );
}

function HomeIndicator({ onDark }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 26,
        zIndex: 60,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-end",
        paddingBottom: 8,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: 134,
          height: 5,
          borderRadius: 9,
          background: onDark ? "rgba(243,238,230,0.55)" : "rgba(14,14,16,0.28)",
        }}
      />
    </div>
  );
}

// ── Bottom navigation — three styles ────────────────────────────
const NAV_TABS = [
  { id: "home", icon: "home", label: "Ride" },
  { id: "plan", icon: "route", label: "Plan" },
  { id: "roads", icon: "roads", label: "Roads" },
  { id: "me", icon: "user", label: "Me" },
];

const LAND_RAIL = 64;

// shared sheet/side-panel positioning: bottom sheet (portrait) | left side panel (landscape)
function sheetStyle(t, opts = {}) {
  if (t.land)
    return {
      position: "absolute",
      left: LAND_RAIL + 24,
      top: 54,
      bottom: 14,
      width: 332,
      zIndex: 16,
      background: t.bg,
      color: t.fg,
      borderRadius: 22,
      border: "1px solid " + t.line,
      boxShadow: "0 24px 60px rgba(14,14,16,0.36)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    };
  return {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 16,
    background: t.bg,
    color: t.fg,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    boxShadow: "0 -12px 40px rgba(14,14,16,0.3)",
    maxHeight: opts.maxH || "56%",
    display: "flex",
    flexDirection: "column",
  };
}

function NavBar({ style, active, onTab, onStart, onDark }) {
  const t = useT();
  const fg = onDark ? "#F3EEE6" : t.fg;
  const idle = onDark ? "rgba(243,238,230,0.5)" : t.mute;
  const surface = onDark ? "rgba(20,21,25,0.82)" : "rgba(245,239,230,0.86)";
  const line = onDark ? t.invLine : t.line;

  if (t.land)
    return (
      <LandRail
        style={style}
        active={active}
        onTab={onTab}
        onStart={onStart}
        t={t}
        surface={surface}
        line={line}
        idle={idle}
      />
    );

  const StartBtn = ({ d = 56 }) => (
    <button
      onClick={onStart}
      aria-label="Start ride"
      style={{
        width: d,
        height: d,
        borderRadius: d,
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        background: t.accent,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 8px 22px rgba(255,106,26,0.4)",
      }}
    >
      <Icon name="nav" size={d * 0.46} color="#0E0E10" sw={2} />
    </button>
  );

  const Tab = ({ tab, labelled }) => {
    const on = active === tab.id;
    return (
      <button
        onClick={() => onTab(tab.id)}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          padding: "4px 6px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: on ? t.accent : idle,
        }}
      >
        <Icon name={tab.icon} size={23} sw={on ? 2.1 : 1.8} />
        {labelled && (
          <span
            style={{
              fontFamily: t.sans,
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: 0.2,
            }}
          >
            {tab.label}
          </span>
        )}
      </button>
    );
  };

  if (style === "dock") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 22,
          zIndex: 40,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 10px",
            background: surface,
            backdropFilter: "blur(22px)",
            WebkitBackdropFilter: "blur(22px)",
            border: "1px solid " + line,
            borderRadius: 999,
            boxShadow: "0 14px 40px rgba(14,14,16,0.22)",
          }}
        >
          {NAV_TABS.slice(0, 2).map((tab) => (
            <DockTab
              key={tab.id}
              tab={tab}
              on={active === tab.id}
              onTab={onTab}
              t={t}
              idle={idle}
            />
          ))}
          <StartBtn d={48} />
          {NAV_TABS.slice(2).map((tab) => (
            <DockTab
              key={tab.id}
              tab={tab}
              on={active === tab.id}
              onTab={onTab}
              t={t}
              idle={idle}
            />
          ))}
        </div>
      </div>
    );
  }

  if (style === "float") {
    return (
      <>
        <div style={{ position: "absolute", left: 18, bottom: 26, zIndex: 40 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "7px 9px",
              background: surface,
              backdropFilter: "blur(22px)",
              WebkitBackdropFilter: "blur(22px)",
              border: "1px solid " + line,
              borderRadius: 999,
              boxShadow: "0 12px 32px rgba(14,14,16,0.20)",
            }}
          >
            {NAV_TABS.map((tab) => (
              <DockTab
                key={tab.id}
                tab={tab}
                on={active === tab.id}
                onTab={onTab}
                t={t}
                idle={idle}
                compact
              />
            ))}
          </div>
        </div>
        <div
          style={{ position: "absolute", right: 18, bottom: 24, zIndex: 40 }}
        >
          <StartBtn d={58} />
        </div>
      </>
    );
  }

  // 'bar' — classic labelled tab bar with raised center action
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        height: 92,
        background: surface,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        borderTop: "1px solid " + line,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-around",
        paddingTop: 12,
      }}
    >
      <Tab tab={NAV_TABS[0]} labelled />
      <Tab tab={NAV_TABS[1]} labelled />
      <div style={{ marginTop: -22 }}>
        <StartBtn d={58} />
      </div>
      <Tab tab={NAV_TABS[2]} labelled />
      <Tab tab={NAV_TABS[3]} labelled />
    </div>
  );
}

function LandRail({ style, active, onTab, onStart, t, surface, line, idle }) {
  const labelled = style === "bar";
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        top: 54,
        bottom: 14,
        width: LAND_RAIL,
        zIndex: 40,
        background: surface,
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        border: "1px solid " + line,
        borderRadius: 22,
        boxShadow: "0 14px 40px rgba(14,14,16,0.22)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "10px 0",
      }}
    >
      {NAV_TABS.slice(0, 2).map((tab) => {
        const on = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTab(tab.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: on ? t.accent : idle,
              padding: "4px 0",
            }}
          >
            <Icon name={tab.icon} size={22} sw={on ? 2.1 : 1.8} />
            {labelled && (
              <span
                style={{ fontFamily: t.sans, fontWeight: 700, fontSize: 8.5 }}
              >
                {tab.label}
              </span>
            )}
          </button>
        );
      })}
      <button
        onClick={onStart}
        aria-label="Start ride"
        style={{
          width: 46,
          height: 46,
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          background: t.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 8px 22px rgba(255,106,26,0.4)",
          margin: "2px 0",
        }}
      >
        <Icon name="nav" size={21} color="#0E0E10" sw={2} />
      </button>
      {NAV_TABS.slice(2).map((tab) => {
        const on = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTab(tab.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: on ? t.accent : idle,
              padding: "4px 0",
            }}
          >
            <Icon name={tab.icon} size={22} sw={on ? 2.1 : 1.8} />
            {labelled && (
              <span
                style={{ fontFamily: t.sans, fontWeight: 700, fontSize: 8.5 }}
              >
                {tab.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function DockTab({ tab, on, onTab, t, idle, compact }) {
  return (
    <button
      onClick={() => onTab(tab.id)}
      style={{
        width: compact ? 38 : 44,
        height: compact ? 38 : 44,
        borderRadius: 999,
        border: "none",
        cursor: "pointer",
        background: on
          ? t.dark
            ? "rgba(255,255,255,0.10)"
            : "rgba(14,14,16,0.07)"
          : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: on ? t.accent : idle,
      }}
    >
      <Icon name={tab.icon} size={compact ? 20 : 22} sw={on ? 2.1 : 1.8} />
    </button>
  );
}

// ── Device frame ────────────────────────────────────────────────
function Phone({ children, onDark, scale = 1, time }) {
  const t = useT();
  const w = t.land ? SCREEN_H : SCREEN_W;
  const h = t.land ? SCREEN_W : SCREEN_H;
  return (
    <div
      style={{
        width: w * scale,
        height: h * scale,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: w,
          height: h,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          borderRadius: 46,
          position: "relative",
          overflow: "hidden",
          background: onDark ? "#0B0C0F" : t.bg,
          boxShadow:
            "0 50px 90px -30px rgba(14,14,16,0.45), 0 0 0 2px rgba(14,14,16,0.9), 0 0 0 7px " +
            (t.dark ? "#1a1b1f" : "#dcd3c4"),
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── In-screen helpers ───────────────────────────────────────────
function Screen({ children, bg, onDark, style }) {
  const t = useT();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: bg || t.bg,
        color: onDark ? "#F3EEE6" : t.fg,
        display: "flex",
        flexDirection: "column",
        fontFamily: t.sans,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Scroll({ children, pad = 20, bottomPad = 120, style }) {
  const t = useT();
  if (t.land)
    return (
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: `8px ${pad}px 26px ${LAND_RAIL + 36}px`,
          WebkitOverflowScrolling: "touch",
          ...style,
        }}
      >
        <div style={{ maxWidth: 660, margin: "0 auto" }}>{children}</div>
      </div>
    );
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        overflowX: "hidden",
        padding: `4px ${pad}px ${bottomPad}px`,
        WebkitOverflowScrolling: "touch",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// Card with direction-aware shape + optional glow/border
function Card({
  children,
  onDark,
  raised,
  accentBorder,
  pad = 16,
  style,
  onClick,
}) {
  const t = useT();
  const bg = onDark
    ? t.dark
      ? "#1B1D23"
      : "rgba(255,255,255,0.07)"
    : raised
      ? t.raised
      : t.raised2;
  return (
    <div
      onClick={onClick}
      style={{
        background: bg,
        borderRadius: t.r,
        padding: pad,
        border:
          "1px solid " +
          (accentBorder ? t.accent + "66" : onDark ? t.invLine : t.line),
        boxShadow:
          t.glow && raised
            ? "0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 30px rgba(0,0,0,0.18)"
            : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function TopBar({ title, onBack, right, onDark }) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexShrink: 0,
        padding: t.land ? `6px 18px 10px ${LAND_RAIL + 36}px` : "6px 18px 10px",
      }}
    >
      {onBack && (
        <button
          onClick={onBack}
          style={{
            width: 38,
            height: 38,
            borderRadius: 999,
            border: "1px solid " + (onDark ? t.invLine : t.line),
            background: onDark ? "rgba(255,255,255,0.06)" : t.raised,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: onDark ? "#F3EEE6" : t.fg,
          }}
        >
          <Icon name="left" size={20} />
        </button>
      )}
      <div
        style={{
          flex: 1,
          fontFamily: t.sans,
          fontWeight: 800,
          fontSize: 17,
          letterSpacing: -0.3,
        }}
      >
        {title}
      </div>
      {right}
    </div>
  );
}

Object.assign(window, {
  SCREEN_W,
  SCREEN_H,
  LAND_RAIL,
  sheetStyle,
  StatusBar,
  HomeIndicator,
  NavBar,
  NAV_TABS,
  Phone,
  Screen,
  Scroll,
  Card,
  TopBar,
});
