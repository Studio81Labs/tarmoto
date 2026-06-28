// tokens.jsx — Tarmoto mobile design tokens + shared atoms.
// Three look/feel directions (Atlas / Onyx / Rally) × light/dark, resolved into one
// token object consumed via context. Keeps every screen DRY across directions.

const QC = ["#E05A3C", "#F0A03C", "#E8D66A", "#C7D36A", "#6FD38A"]; // q1..q5
const QLABEL = ["Avoid", "Rough", "Fair", "Great", "Hero"];
const QFULL = ["Very poor", "Poor", "Fair", "Good", "Excellent"];

function resolveTokens(cfg) {
  const dir = cfg.direction || "atlas";
  const dark = cfg.theme === "dark";

  const light = {
    bg: "#F5EFE6",
    raised: "#FFFFFF",
    raised2: "#EDE6DA",
    sunken: "#E7DECF",
    fg: "#0E0E10",
    dim: "rgba(14,14,16,0.60)",
    mute: "rgba(14,14,16,0.42)",
    faint: "rgba(14,14,16,0.20)",
    line: "rgba(14,14,16,0.10)",
    lineStrong: "rgba(14,14,16,0.16)",
    invBg: "#0E0E10",
    invFg: "#F5EFE6",
    invDim: "rgba(245,239,230,0.62)",
    invLine: "rgba(245,239,230,0.14)",
    qEmpty: "rgba(14,14,16,0.08)",
  };
  const night = {
    bg: "#111216",
    raised: "#1B1D23",
    raised2: "#23262D",
    sunken: "#0B0C0F",
    fg: "#F3EEE6",
    dim: "rgba(243,238,230,0.62)",
    mute: "rgba(243,238,230,0.42)",
    faint: "rgba(243,238,230,0.22)",
    line: "rgba(243,238,230,0.10)",
    lineStrong: "rgba(243,238,230,0.18)",
    invBg: "#F3EEE6",
    invFg: "#0E0E10",
    invDim: "rgba(14,14,16,0.60)",
    invLine: "rgba(14,14,16,0.12)",
    qEmpty: "rgba(243,238,230,0.10)",
  };
  const s = dark ? night : light;
  const accent = "#FF6A1A";

  const persona = {
    atlas: {
      name: "Atlas",
      r: 18,
      rLg: 24,
      rSm: 12,
      glow: false,
      h1: 30,
      track: -0.6,
      chunk: false,
      blurb: "Editorial cartography",
    },
    onyx: {
      name: "Onyx",
      r: 16,
      rLg: 22,
      rSm: 11,
      glow: true,
      h1: 28,
      track: -0.4,
      chunk: false,
      blurb: "Instrument cluster",
    },
    rally: {
      name: "Rally",
      r: 26,
      rLg: 32,
      rSm: 14,
      glow: false,
      h1: 36,
      track: -1.1,
      chunk: true,
      blurb: "Loud & sporty",
    },
  }[dir];

  return {
    dir,
    dark,
    accent,
    QC,
    QLABEL,
    QFULL,
    land: cfg.orient === "landscape",
    sans: "'Space Grotesk', system-ui, sans-serif",
    mono: "'JetBrains Mono', monospace",
    ...s,
    ...persona,
  };
}

const TokenCtx = React.createContext(
  resolveTokens({ direction: "atlas", theme: "light" }),
);
const useT = () => React.useContext(TokenCtx);

// ── Stamp: mono uppercase micro-label ───────────────────────────
function Stamp({ children, color, size = 10, style }) {
  const t = useT();
  return (
    <span
      style={{
        fontFamily: t.mono,
        fontSize: size,
        fontWeight: 700,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        color: color || t.mute,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── Quality bars ────────────────────────────────────────────────
function QBars({ q, size = 7, gap = 2, empty }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", gap, verticalAlign: "middle" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          style={{
            width: size,
            height: size * 1.85,
            borderRadius: 2,
            background: n <= q ? QC[q - 1] : empty || t.qEmpty,
          }}
        />
      ))}
    </span>
  );
}

// ── Chip / toggle pill ──────────────────────────────────────────
function Chip({ children, active, onClick, accent, dark, style }) {
  const t = useT();
  const onDark = dark;
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 13px",
        borderRadius: 999,
        cursor: "pointer",
        whiteSpace: "nowrap",
        fontFamily: t.sans,
        fontWeight: 700,
        fontSize: 12.5,
        letterSpacing: 0.1,
        border:
          "1px solid " + (active ? "transparent" : onDark ? t.invLine : t.line),
        background: active
          ? accent
            ? t.accent
            : onDark
              ? "#F3EEE6"
              : t.fg
          : onDark
            ? "rgba(255,255,255,0.06)"
            : "transparent",
        color: active
          ? accent
            ? "#0E0E10"
            : onDark
              ? "#0E0E10"
              : t.bg
          : onDark
            ? "#F3EEE6"
            : t.fg,
        transition: "all 140ms ease",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── Big metric block ────────────────────────────────────────────
function Metric({
  value,
  unit,
  label,
  color,
  onDark,
  size = 26,
  align = "left",
}) {
  const t = useT();
  return (
    <div style={{ textAlign: align }}>
      <div
        style={{
          fontFamily: t.sans,
          fontWeight: 800,
          fontSize: size,
          lineHeight: 1,
          letterSpacing: -0.5,
          color: color || (onDark ? "#F3EEE6" : t.fg),
          display: "flex",
          alignItems: "baseline",
          gap: 3,
          justifyContent: align === "center" ? "center" : "flex-start",
        }}
      >
        {value}
        {unit && (
          <span
            style={{
              fontFamily: t.mono,
              fontSize: size * 0.4,
              fontWeight: 600,
              color: onDark ? t.invDim : t.mute,
            }}
          >
            {unit}
          </span>
        )}
      </div>
      {label && (
        <div style={{ marginTop: 5 }}>
          <Stamp size={9} color={onDark ? t.invDim : t.mute}>
            {label}
          </Stamp>
        </div>
      )}
    </div>
  );
}

// ── Icon set — hand-rolled stroke icons (Lucide-ish, geometric) ──
function Icon({
  name,
  size = 22,
  color = "currentColor",
  sw = 1.8,
  fill = "none",
  style,
}) {
  const p = {
    stroke: color,
    strokeWidth: sw,
    fill,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  const paths = {
    home: (
      <>
        <path d="M3 11.5 12 4l9 7.5" {...p} />
        <path d="M6 10v9h12v-9" {...p} />
      </>
    ),
    roads: (
      <>
        <circle cx="12" cy="12" r="8.4" {...p} />
        <path
          d="M3.6 12H20.4M12 3.6c2.6 2.4 2.6 14.4 0 16.8M12 3.6c-2.6 2.4-2.6 14.4 0 16.8"
          {...p}
        />
      </>
    ),
    route: (
      <>
        <circle cx="6" cy="18" r="2.4" {...p} />
        <circle cx="18" cy="6" r="2.4" {...p} />
        <path
          d="M8.4 18H14a3.5 3.5 0 0 0 0-7H10a3.5 3.5 0 0 1 0-7h5.6"
          {...p}
        />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.6" {...p} />
        <path d="M5 20c0-4 3.2-6 7-6s7 2 7 6" {...p} />
      </>
    ),
    gauge: (
      <>
        <path d="M4.5 18a9 9 0 1 1 15 0" {...p} />
        <path d="M12 14l4-4" {...p} />
        <circle cx="12" cy="14" r="1.3" fill={color} stroke="none" />
      </>
    ),
    alert: (
      <>
        <path d="M12 3 2.5 20h19L12 3Z" {...p} />
        <path d="M12 10v4.5" {...p} />
        <circle
          cx="12"
          cy="17.4"
          r="0.4"
          fill={color}
          stroke={color}
          strokeWidth="1.2"
        />
      </>
    ),
    bolt: <path d="M13 3 5 13h5l-1 8 8-11h-5l1-7Z" {...p} />,
    plus: (
      <>
        <path d="M12 5v14M5 12h14" {...p} />
      </>
    ),
    flag: (
      <>
        <path d="M6 21V4M6 4h11l-2.5 4L17 12H6" {...p} />
      </>
    ),
    mountain: <path d="M3 19 9.5 7l3.5 6 2-3 5 9H3Z" {...p} />,
    share: (
      <>
        <circle cx="6" cy="12" r="2.4" {...p} />
        <circle cx="17" cy="6" r="2.4" {...p} />
        <circle cx="17" cy="18" r="2.4" {...p} />
        <path d="M8.2 10.8 14.8 7.2M8.2 13.2l6.6 3.6" {...p} />
      </>
    ),
    left: <path d="M15 5l-7 7 7 7" {...p} />,
    right: <path d="M9 5l7 7-7 7" {...p} />,
    close: <path d="M6 6l12 12M18 6 6 18" {...p} />,
    layers: (
      <>
        <path d="M12 3 3 8l9 5 9-5-9-5Z" {...p} />
        <path d="M3 13l9 5 9-5M3 18l9 5 9-5" {...p} opacity="0.5" />
      </>
    ),
    filter: <path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" {...p} />,
    pin: (
      <>
        <path d="M12 21s7-5.4 7-11A7 7 0 0 0 5 10c0 5.6 7 11 7 11Z" {...p} />
        <circle cx="12" cy="10" r="2.4" {...p} />
      </>
    ),
    nav: <path d="M12 3 4 21l8-4 8 4L12 3Z" {...p} />,
    check: <path d="M5 12.5 10 17l9-10" {...p} />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8.4" {...p} />
        <path d="M12 7.5V12l3 2" {...p} />
      </>
    ),
    trend: (
      <>
        <path d="M4 16l5-5 3 3 8-8" {...p} />
        <path d="M16 6h5v5" {...p} />
      </>
    ),
    speed: (
      <>
        <path d="M12 4a8 8 0 0 1 8 8M12 4a8 8 0 0 0-8 8" {...p} />
        <path d="M4 12h2M18 12h2M12 12l3.5-2.5" {...p} />
        <circle cx="12" cy="12" r="1.2" fill={color} stroke="none" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" {...p} />
        <path
          d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
          {...p}
        />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" {...p} />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" {...p} />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" {...p} />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" {...p} />
      </>
    ),
    phone: <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" {...p} />,
    heart: (
      <path
        d="M12 20s-7-4.5-7-9.5A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 7 2.5C19 15.5 12 20 12 20Z"
        {...p}
      />
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" {...p} />
        <path
          d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
          {...p}
        />
      </>
    ),
    moon: <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" {...p} />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {paths[name]}
    </svg>
  );
}

// ── Primary button ──────────────────────────────────────────────
function Btn({
  children,
  onClick,
  accent,
  ghost,
  onDark,
  size = "md",
  icon,
  style,
}) {
  const t = useT();
  const pad =
    size === "lg" ? "17px 22px" : size === "sm" ? "10px 15px" : "14px 19px";
  const fs = size === "lg" ? 16.5 : size === "sm" ? 13 : 15;
  let bg,
    col,
    border = "none";
  if (accent) {
    bg = t.accent;
    col = "#0E0E10";
  } else if (ghost) {
    bg = "transparent";
    col = onDark ? "#F3EEE6" : t.fg;
    border = "1px solid " + (onDark ? t.invLine : t.lineStrong);
  } else {
    bg = onDark ? "#F3EEE6" : t.fg;
    col = onDark ? "#0E0E10" : t.bg;
  }
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        padding: pad,
        borderRadius: t.chunk ? 16 : 14,
        border,
        background: bg,
        color: col,
        cursor: "pointer",
        fontFamily: t.sans,
        fontWeight: 800,
        fontSize: fs,
        letterSpacing: 0.1,
        width: "100%",
        boxShadow:
          accent && t.glow ? "0 8px 26px rgba(255,106,26,0.34)" : "none",
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

Object.assign(window, {
  QC,
  QLABEL,
  QFULL,
  resolveTokens,
  TokenCtx,
  useT,
  Stamp,
  QBars,
  Chip,
  Metric,
  Icon,
  Btn,
});
