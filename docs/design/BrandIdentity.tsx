import { useState } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BrandColor {
  hex: string;
  name: string;
}

interface LogoMarkProps {
  size?: number;
  color?: string;
  bg?: string;
}

interface WordmarkProps {
  color?: string;
  accent?: string;
  size?: number;
}

interface LogoLockupProps {
  mark: React.ComponentType<LogoMarkProps>;
  color: string;
  accent: string;
  bg: string;
  textColor: string;
  size?: number;
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

interface ColorSwatchProps {
  color: BrandColor;
  size?: "normal" | "small";
}

/* ------------------------------------------------------------------ */
/*  Color palette                                                      */
/* ------------------------------------------------------------------ */

const colors: Record<string, BrandColor> = {
  primary: { hex: "#0ED3CF", name: "Tarmoto Cyan" },
  primaryDark: { hex: "#0A9E9B", name: "Cyan Deep" },
  dark1: { hex: "#070A10", name: "Asphalt Black" },
  dark2: { hex: "#0C1018", name: "Night Road" },
  dark3: { hex: "#1A2235", name: "Twilight" },
  surface: { hex: "#222D42", name: "Dashboard" },
  text1: { hex: "#E8ECF2", name: "Headlight" },
  text2: { hex: "#8B95A8", name: "Fog" },
  text3: { hex: "#4A5568", name: "Gravel" },
  green: { hex: "#22C55E", name: "Excellent" },
  lime: { hex: "#84CC16", name: "Good" },
  yellow: { hex: "#EAB308", name: "Fair" },
  orange: { hex: "#F97316", name: "Poor" },
  red: { hex: "#EF4444", name: "Very Poor" },
  white: { hex: "#FFFFFF", name: "White" },
};

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function ColorSwatch({ color, size = "normal" }: ColorSwatchProps) {
  const isSmall = size === "small";
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          width: isSmall ? 48 : 72,
          height: isSmall ? 48 : 72,
          borderRadius: isSmall ? 10 : 14,
          background: color.hex,
          border:
            color.hex === "#FFFFFF"
              ? "1px solid rgba(255,255,255,.15)"
              : "none",
          boxShadow: `0 4px 20px ${color.hex}22`,
        }}
      />
      <p
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "#E8ECF2",
          marginTop: 8,
        }}
      >
        {color.name}
      </p>
      <p
        style={{
          fontSize: 10,
          color: "#4A5568",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {color.hex}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Logo Mark: T with pulse wave                                       */
/* ------------------------------------------------------------------ */

function LogoMark({
  size = 64,
  color = "#0ED3CF",
  bg = "transparent",
}: LogoMarkProps) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" fill="none">
      {bg !== "transparent" && (
        <rect width="100" height="100" rx="22" fill={bg} />
      )}
      {/* T shape */}
      <rect x="20" y="18" width="60" height="10" rx="3" fill={color} />
      <rect x="42" y="18" width="16" height="38" rx="3" fill={color} />
      {/* Pulse wave cutting across bottom */}
      <path
        d="M 12 72 L 30 72 L 36 60 L 42 80 L 48 55 L 54 78 L 60 64 L 66 72 L 88 72"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Logo Mark 2: Road perspective with pulse                           */
/* ------------------------------------------------------------------ */

function LogoMark2({
  size = 64,
  color = "#0ED3CF",
  bg = "transparent",
}: LogoMarkProps) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" fill="none">
      {bg !== "transparent" && (
        <rect width="100" height="100" rx="22" fill={bg} />
      )}
      {/* Road converging lines */}
      <path
        d="M 15 85 L 50 22"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        opacity=".5"
      />
      <path
        d="M 85 85 L 50 22"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        opacity=".5"
      />
      {/* Center dashes */}
      <line
        x1="50"
        y1="30"
        x2="50"
        y2="40"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        opacity=".6"
      />
      <line
        x1="50"
        y1="48"
        x2="50"
        y2="55"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        opacity=".6"
      />
      {/* Pulse wave across middle */}
      <path
        d="M 14 65 L 28 65 L 34 55 L 40 73 L 46 50 L 52 70 L 58 58 L 64 65 L 86 65"
        stroke={color}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Logo Mark 3: Minimal T with underline pulse                        */
/* ------------------------------------------------------------------ */

function LogoMark3({
  size = 64,
  color = "#0ED3CF",
  bg = "transparent",
}: LogoMarkProps) {
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" fill="none">
      {bg !== "transparent" && (
        <rect width="100" height="100" rx="22" fill={bg} />
      )}
      {/* Bold T */}
      <rect x="18" y="20" width="64" height="12" rx="4" fill={color} />
      <rect x="40" y="20" width="20" height="42" rx="4" fill={color} />
      {/* Underline pulse */}
      <path
        d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
        stroke={color}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Wordmark                                                           */
/* ------------------------------------------------------------------ */

function Wordmark({
  color = "#E8ECF2",
  accent = "#0ED3CF",
  size = 32,
}: WordmarkProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.25,
        userSelect: "none",
      }}
    >
      <span
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontWeight: 900,
          fontSize: size,
          letterSpacing: "-0.04em",
          color: color,
        }}
      >
        TAR
      </span>
      <span
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontWeight: 900,
          fontSize: size,
          letterSpacing: "-0.04em",
          color: accent,
        }}
      >
        MOTO
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Full logo lockup                                                   */
/* ------------------------------------------------------------------ */

function LogoLockup({
  mark: Mark,
  color,
  accent,
  bg,
  textColor,
  size = 48,
}: LogoLockupProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <Mark size={size} color={accent} bg={bg} />
      <div>
        <Wordmark color={textColor} accent={accent} size={size * 0.5} />
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: size * 0.18,
            fontWeight: 400,
            color: color,
            letterSpacing: "0.15em",
            marginTop: 2,
            opacity: 0.6,
          }}
        >
          KNOW THE ROAD BEFORE YOU RIDE IT
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: SectionProps) {
  return (
    <div style={{ marginBottom: 56 }}>
      <h2
        style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 14,
          fontWeight: 700,
          color: "#0ED3CF",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 24,
          paddingBottom: 12,
          borderBottom: "1px solid rgba(255,255,255,.06)",
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main BrandIdentity component                                       */
/* ------------------------------------------------------------------ */

export default function BrandIdentity() {
  const [activeConcept, setActiveConcept] = useState(0);

  const concepts: Array<{
    name: string;
    desc: string;
    Mark: React.ComponentType<LogoMarkProps>;
  }> = [
    {
      name: "Minimal T",
      desc: "Clean bold T with an underline pulse — the primary logo. Works at all sizes from app icon to billboard. The underline pulse is the signature element that makes Tarmoto instantly recognizable.",
      Mark: LogoMark3,
    },
    {
      name: "Pulse T",
      desc: "The letter T with a vibration pulse wave cutting through it — secondary mark for contexts where more visual weight is needed.",
      Mark: LogoMark,
    },
    {
      name: "Road pulse",
      desc: "Converging road perspective with a pulse wave — illustrative variant for marketing materials, presentations, and editorial use.",
      Mark: LogoMark2,
    },
  ];

  const ActiveMark = concepts[activeConcept].Mark;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#070A10",
        fontFamily: "'Outfit', sans-serif",
        color: "#E8ECF2",
        padding: "40px 24px 60px",
      }}
    >
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 48, textAlign: "center" }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#0ED3CF",
              letterSpacing: "0.2em",
              marginBottom: 8,
            }}
          >
            BRAND IDENTITY
          </p>
          <h1
            style={{
              fontSize: 36,
              fontWeight: 900,
              letterSpacing: "-0.04em",
              marginBottom: 8,
            }}
          >
            Tarmoto
          </h1>
          <p style={{ fontSize: 14, color: "#4A5568" }}>v1.0 — April 2026</p>
        </div>

        {/* 1. LOGO CONCEPTS */}
        <Section title="01 / Logo concepts">
          {/* Concept selector */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            {concepts.map((c, i) => (
              <button
                key={i}
                onClick={() => setActiveConcept(i)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: `1px solid ${
                    activeConcept === i
                      ? "rgba(14,211,207,.4)"
                      : "rgba(255,255,255,.08)"
                  }`,
                  background:
                    activeConcept === i
                      ? "rgba(14,211,207,.1)"
                      : "rgba(30,41,59,.4)",
                  color: activeConcept === i ? "#0ED3CF" : "#8B95A8",
                  fontSize: 13,
                  fontWeight: activeConcept === i ? 700 : 500,
                  cursor: "pointer",
                  fontFamily: "'Outfit', sans-serif",
                }}
              >
                {c.name}
              </button>
            ))}
          </div>

          <p
            style={{
              fontSize: 13,
              color: "#8B95A8",
              marginBottom: 24,
              lineHeight: 1.6,
            }}
          >
            {concepts[activeConcept].desc}
          </p>

          {/* Logo on dark bg */}
          <div
            style={{
              background: "#0C1018",
              borderRadius: 20,
              padding: "40px 32px",
              border: "1px solid rgba(255,255,255,.06)",
              marginBottom: 12,
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#4A5568",
                marginBottom: 20,
                letterSpacing: ".08em",
                fontWeight: 600,
              }}
            >
              ON DARK BACKGROUND
            </p>
            <LogoLockup
              mark={ActiveMark}
              color="#8B95A8"
              accent="#0ED3CF"
              bg="transparent"
              textColor="#E8ECF2"
              size={56}
            />
          </div>

          {/* Logo on light bg */}
          <div
            style={{
              background: "#F1F3F7",
              borderRadius: 20,
              padding: "40px 32px",
              marginBottom: 12,
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#8B95A8",
                marginBottom: 20,
                letterSpacing: ".08em",
                fontWeight: 600,
              }}
            >
              ON LIGHT BACKGROUND
            </p>
            <LogoLockup
              mark={ActiveMark}
              color="#4A5568"
              accent="#0A9E9B"
              bg="transparent"
              textColor="#1A2235"
              size={56}
            />
          </div>

          {/* Monochrome */}
          <div
            style={{
              background: "#1A2235",
              borderRadius: 20,
              padding: "40px 32px",
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#4A5568",
                marginBottom: 20,
                letterSpacing: ".08em",
                fontWeight: 600,
              }}
            >
              MONOCHROME
            </p>
            <LogoLockup
              mark={ActiveMark}
              color="#4A5568"
              accent="#E8ECF2"
              bg="transparent"
              textColor="#E8ECF2"
              size={56}
            />
          </div>
        </Section>

        {/* 2. APP ICON */}
        <Section title="02 / App icon">
          <div
            style={{
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            {[80, 64, 48, 36, 24].map((s) => (
              <div key={s} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: s,
                    height: s,
                    borderRadius: s * 0.22,
                    background:
                      "linear-gradient(145deg, #0C1018 0%, #1A2235 100%)",
                    border: "1px solid rgba(14,211,207,.15)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 24px rgba(0,0,0,.4)",
                  }}
                >
                  <ActiveMark size={s * 0.7} color="#0ED3CF" />
                </div>
                <p style={{ fontSize: 9, color: "#4A5568", marginTop: 6 }}>
                  {s}px
                </p>
              </div>
            ))}

            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 18,
                  background: "#0ED3CF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 4px 24px rgba(14,211,207,.3)",
                }}
              >
                <ActiveMark size={56} color="#070A10" />
              </div>
              <p style={{ fontSize: 9, color: "#4A5568", marginTop: 6 }}>
                Inverted
              </p>
            </div>
          </div>
        </Section>

        {/* 3. COLOR PALETTE */}
        <Section title="03 / Color palette">
          <p
            style={{
              fontSize: 13,
              color: "#8B95A8",
              marginBottom: 20,
              lineHeight: 1.6,
            }}
          >
            The primary cyan represents technology and sensing. Dark tones
            ground the brand in the road. The quality scale (green to red) is
            functional — used only for road classification, never decoratively.
          </p>

          <p
            style={{
              fontSize: 11,
              color: "#4A5568",
              fontWeight: 700,
              letterSpacing: ".08em",
              marginBottom: 12,
            }}
          >
            PRIMARY
          </p>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 28,
              flexWrap: "wrap",
            }}
          >
            <ColorSwatch color={colors.primary} />
            <ColorSwatch color={colors.primaryDark} />
          </div>

          <p
            style={{
              fontSize: 11,
              color: "#4A5568",
              fontWeight: 700,
              letterSpacing: ".08em",
              marginBottom: 12,
            }}
          >
            DARK TONES
          </p>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 28,
              flexWrap: "wrap",
            }}
          >
            <ColorSwatch color={colors.dark1} />
            <ColorSwatch color={colors.dark2} />
            <ColorSwatch color={colors.dark3} />
            <ColorSwatch color={colors.surface} />
          </div>

          <p
            style={{
              fontSize: 11,
              color: "#4A5568",
              fontWeight: 700,
              letterSpacing: ".08em",
              marginBottom: 12,
            }}
          >
            TEXT
          </p>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 28,
              flexWrap: "wrap",
            }}
          >
            <ColorSwatch color={colors.text1} />
            <ColorSwatch color={colors.text2} />
            <ColorSwatch color={colors.text3} />
          </div>

          <p
            style={{
              fontSize: 11,
              color: "#4A5568",
              fontWeight: 700,
              letterSpacing: ".08em",
              marginBottom: 12,
            }}
          >
            ROAD QUALITY SCALE (functional only)
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <ColorSwatch color={colors.green} size="small" />
            <ColorSwatch color={colors.lime} size="small" />
            <ColorSwatch color={colors.yellow} size="small" />
            <ColorSwatch color={colors.orange} size="small" />
            <ColorSwatch color={colors.red} size="small" />
          </div>

          {/* Quality bar demo */}
          <div style={{ marginTop: 20 }}>
            <div
              style={{
                display: "flex",
                gap: 3,
                height: 14,
                borderRadius: 7,
                overflow: "hidden",
              }}
            >
              {[
                colors.green,
                colors.green,
                colors.green,
                colors.lime,
                colors.lime,
                colors.green,
                colors.green,
                colors.yellow,
                colors.green,
                colors.green,
                colors.green,
                colors.lime,
                colors.orange,
                colors.red,
                colors.lime,
                colors.green,
              ].map((c, i) => (
                <div
                  key={i}
                  style={{ flex: 1, background: c.hex, borderRadius: 4 }}
                />
              ))}
            </div>
            <p
              style={{
                fontSize: 9,
                color: "#4A5568",
                marginTop: 4,
                textAlign: "center",
              }}
            >
              Road quality bar — how the scale appears in-app
            </p>
          </div>
        </Section>

        {/* 4. TYPOGRAPHY */}
        <Section title="04 / Typography">
          <div
            style={{
              background: "#0C1018",
              borderRadius: 16,
              padding: "28px 24px",
              border: "1px solid rgba(255,255,255,.06)",
              marginBottom: 16,
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#4A5568",
                fontWeight: 700,
                letterSpacing: ".08em",
                marginBottom: 16,
              }}
            >
              PRIMARY — OUTFIT
            </p>
            <p
              style={{
                fontSize: 36,
                fontWeight: 900,
                letterSpacing: "-0.04em",
                marginBottom: 4,
              }}
            >
              Know the road before you ride it.
            </p>
            <p style={{ fontSize: 13, color: "#4A5568", fontWeight: 400 }}>
              Outfit Black (900) — Headlines and logo wordmark
            </p>
            <div
              style={{
                marginTop: 20,
                paddingTop: 20,
                borderTop: "1px solid rgba(255,255,255,.04)",
              }}
            >
              <p
                style={{
                  fontSize: 16,
                  fontWeight: 400,
                  lineHeight: 1.7,
                  color: "#8B95A8",
                }}
              >
                Every ride with Tarmoto passively collects road surface data via
                your phone&apos;s accelerometer. Over time, we build a database
                of road quality that no competitor can replicate.
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: "#4A5568",
                  fontWeight: 400,
                  marginTop: 8,
                }}
              >
                Outfit Regular (400) — Body text
              </p>
            </div>
          </div>

          <div
            style={{
              background: "#0C1018",
              borderRadius: 16,
              padding: "28px 24px",
              border: "1px solid rgba(255,255,255,.06)",
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#4A5568",
                fontWeight: 700,
                letterSpacing: ".08em",
                marginBottom: 16,
              }}
            >
              MONOSPACE — JETBRAINS MONO
            </p>
            <p
              style={{
                fontSize: 16,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 500,
                color: "#0ED3CF",
              }}
            >
              RMS: 2.34 m/s² — Classification: Good
            </p>
            <p
              style={{
                fontSize: 13,
                color: "#4A5568",
                fontWeight: 400,
                marginTop: 8,
              }}
            >
              JetBrains Mono Medium (500) — Data, metrics, labels, code
            </p>
          </div>

          <div style={{ marginTop: 20 }}>
            <p
              style={{
                fontSize: 11,
                color: "#4A5568",
                fontWeight: 700,
                letterSpacing: ".08em",
                marginBottom: 12,
              }}
            >
              TYPE SCALE
            </p>
            {[
              {
                size: 36,
                weight: 900,
                label: "H1 — Page titles",
                text: "Road Quality Map",
              },
              {
                size: 24,
                weight: 800,
                label: "H2 — Section headings",
                text: "Multi-Day Trip Planner",
              },
              {
                size: 18,
                weight: 700,
                label: "H3 — Card titles",
                text: "Frenštát – Pustevny Pass",
              },
              {
                size: 14,
                weight: 600,
                label: "Body bold — Labels",
                text: "Surface quality: Excellent",
              },
              {
                size: 14,
                weight: 400,
                label: "Body — Content",
                text: "This 22km segment has 47 curves and a quality score of 4.9",
              },
              {
                size: 12,
                weight: 400,
                label: "Small — Metadata",
                text: "Last updated 3 days ago · 342 riders this month",
              },
            ].map((t, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 16,
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(255,255,255,.03)",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "#4A5568",
                    minWidth: 160,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {t.label}
                </span>
                <span
                  style={{
                    fontSize: t.size,
                    fontWeight: t.weight,
                    letterSpacing: t.weight >= 700 ? "-0.03em" : "0",
                  }}
                >
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* 5. BRAND VOICE */}
        <Section title="05 / Brand voice">
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            {[
              {
                do: true,
                text: "Know the road before you ride it.",
                note: "Clear, direct, benefit-first",
              },
              {
                do: false,
                text: "The ultimate AI-powered road analysis platform.",
                note: "Buzzwordy, vague",
              },
              {
                do: true,
                text: "Road quality: Excellent. Smooth asphalt, 47 curves.",
                note: "Data-driven, specific",
              },
              {
                do: false,
                text: "This road is absolutely amazing and perfect!!!",
                note: "Subjective, hype",
              },
              {
                do: true,
                text: "Gravel ahead in 1.2 km — reported 8 min ago.",
                note: "Actionable, time-bound",
              },
              {
                do: false,
                text: "Warning! Dangerous conditions detected!",
                note: "Alarmist, vague",
              },
            ].map((v, i) => (
              <div
                key={i}
                style={{
                  background: v.do
                    ? "rgba(34,197,94,.06)"
                    : "rgba(239,68,68,.06)",
                  border: `1px solid ${
                    v.do ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)"
                  }`,
                  borderRadius: 12,
                  padding: "14px 16px",
                }}
              >
                <p
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: v.do ? "#22C55E" : "#EF4444",
                    letterSpacing: ".06em",
                    marginBottom: 6,
                  }}
                >
                  {v.do ? "DO" : "DON'T"}
                </p>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: 4,
                    color: v.do ? "#E8ECF2" : "#8B95A8",
                  }}
                >
                  &ldquo;{v.text}&rdquo;
                </p>
                <p style={{ fontSize: 10, color: "#4A5568" }}>{v.note}</p>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 20,
              padding: 20,
              background: "#0C1018",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,.06)",
            }}
          >
            <p
              style={{
                fontSize: 11,
                color: "#4A5568",
                fontWeight: 700,
                letterSpacing: ".08em",
                marginBottom: 10,
              }}
            >
              BRAND ATTRIBUTES
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                "Technical but approachable",
                "Data-driven, never subjective",
                "Rider-first, not tech-first",
                "Direct, no fluff",
                "Community-powered",
                "Safety without alarm",
              ].map((a, i) => (
                <span
                  key={i}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    background: "rgba(14,211,207,.06)",
                    border: "1px solid rgba(14,211,207,.12)",
                    fontSize: 12,
                    color: "#0ED3CF",
                    fontWeight: 500,
                  }}
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        </Section>

        {/* 6. CLEAR SPACE & MINIMUM SIZE */}
        <Section title="06 / Clear space & minimum size">
          <div
            style={{
              background: "#0C1018",
              borderRadius: 16,
              padding: "40px 32px",
              border: "1px solid rgba(255,255,255,.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ position: "relative", display: "inline-block" }}>
              {/* Clear space guides */}
              <div
                style={{
                  position: "absolute",
                  inset: -24,
                  border: "1px dashed rgba(14,211,207,.2)",
                  borderRadius: 8,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: -24,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontSize: 9,
                  color: "#0ED3CF",
                }}
              >
                1x height
              </div>
              <LogoLockup
                mark={ActiveMark}
                color="#8B95A8"
                accent="#0ED3CF"
                bg="transparent"
                textColor="#E8ECF2"
                size={48}
              />
            </div>
          </div>
          <p
            style={{
              fontSize: 11,
              color: "#4A5568",
              marginTop: 12,
              lineHeight: 1.6,
            }}
          >
            Maintain clear space equal to the height of the logo mark on all
            sides. Minimum logo width: 120px for the full lockup, 24px for the
            mark alone.
          </p>
        </Section>

        {/* Footer */}
        <div
          style={{
            textAlign: "center",
            paddingTop: 32,
            borderTop: "1px solid rgba(255,255,255,.06)",
          }}
        >
          <LogoMark3 size={32} color="#4A5568" />
          <p style={{ fontSize: 11, color: "#4A5568", marginTop: 8 }}>
            Tarmoto Brand Identity v1.0 — April 2026
          </p>
          <p style={{ fontSize: 10, color: "#2D3748", marginTop: 4 }}>
            tarmoto.app
          </p>
        </div>
      </div>
    </div>
  );
}
