import { Section, SubStamp } from "../Section";
import { palette, qualityColors } from "@tarmoto/ui";

/* -------- 01 · COLOR SURFACES -------- */

interface Swatch {
  name: string;
  varName: string;
  hex: string;
  chipClass: string;
  label: string;
  onDark?: boolean;
  tiny?: boolean;
}

const SURFACES: Swatch[] = [
  {
    name: "Cream",
    varName: "--cream / --bg",
    hex: palette.cream,
    chipClass: "bg-cream",
    label: "CANVAS",
  },
  {
    name: "Paper",
    varName: "--paper / --bg-raised",
    hex: palette.paper,
    chipClass: "bg-paper",
    label: "RAISED",
  },
  {
    name: "Paper 2",
    varName: "--paper-2 / --bg-sunken",
    hex: palette.paper2,
    chipClass: "bg-paper-2",
    label: "SUNKEN",
  },
  {
    name: "Ink",
    varName: "--ink / --fg",
    hex: palette.ink,
    chipClass: "bg-ink",
    label: "INVERSE",
    onDark: true,
  },
];

const ACCENTS: Swatch[] = [
  {
    name: "Accent",
    varName: "--accent",
    hex: palette.accent,
    chipClass: "bg-accent",
    label: "HIGHLIGHT",
  },
  {
    name: "Tarmac",
    varName: "--tarmac",
    hex: palette.tarmac,
    chipClass: "bg-tarmac",
    label: "DARK PANEL",
    onDark: true,
  },
];

function SwatchCard({ name, varName, hex, chipClass, label, onDark }: Swatch) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-cream">
      <div className={`relative h-[110px] border-b border-line ${chipClass}`}>
        <span
          className={`absolute bottom-2 left-3 font-mono text-[10px] font-bold uppercase tracking-[1px] ${onDark ? "text-cream" : "text-ink"}`}
        >
          {label}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3.5 py-3">
        <div className="text-[12.5px] font-bold">{name}</div>
        <div className="font-mono text-[10px] text-fg-dim">{varName}</div>
        <div className="font-mono text-[10px] text-fg-mute">{hex}</div>
      </div>
    </div>
  );
}

export function ColorsSection() {
  return (
    <Section
      id="colors"
      num="01 · Color"
      title="Surfaces & foreground."
      intro={
        <>
          The whole product lives on cream paper with ink type. Orange (
          <span className="font-mono">--accent</span>) is the only spark.
          Surfaces step from <span className="font-mono">--cream</span> outward
          (lighter air) and inward (deeper paper). Inverse surfaces use{" "}
          <span className="font-mono">--ink</span>.
        </>
      }
    >
      <div className="mb-7 grid grid-cols-4 gap-3.5">
        {SURFACES.map((s) => (
          <SwatchCard key={s.name} {...s} />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-3.5">
        {ACCENTS.map((s) => (
          <SwatchCard key={s.name} {...s} />
        ))}
      </div>
    </Section>
  );
}

/* -------- 02 · QUALITY SCALE -------- */

const QUALITY = [
  { tier: 1, name: "Avoid", note: "Potholes, gravel patches, riding-hostile" },
  { tier: 2, name: "Rough", note: "Doable, but you feel every joint" },
  { tier: 3, name: "OK", note: "Mid-class asphalt, the baseline" },
  { tier: 4, name: "Great", note: "Smooth, predictable, good lines" },
  { tier: 5, name: "Hero", note: "Glass-smooth, a road to come back for" },
];

export function QualitySection() {
  return (
    <Section
      id="quality"
      num="02 · Quality"
      title="The five road tones."
      tone="tinted"
      intro={
        <>
          The five-stop ramp powers{" "}
          <span className="font-mono">QualityBars</span>, map ribbons, and any
          segment-coloured visual. Always warm → green, left to right. Don't
          recolour, don't reorder.
        </>
      }
    >
      <div className="grid grid-cols-5 gap-3.5">
        {QUALITY.map((q) => (
          <div
            key={q.tier}
            className="flex flex-col overflow-hidden rounded-xl border border-line bg-cream"
          >
            <div
              className="relative h-[110px] border-b border-line"
              style={{ background: qualityColors[q.tier - 1] }}
            >
              <span className="absolute bottom-2 left-3 font-mono text-[10px] font-bold uppercase tracking-[1px] text-ink">
                Q{q.tier}
              </span>
            </div>
            <div className="flex flex-col gap-1 px-3.5 py-3">
              <div className="text-[12.5px] font-bold">{q.name}</div>
              <div className="font-mono text-[10px] text-fg-dim">
                --q{q.tier}
              </div>
              <div className="font-mono text-[10px] text-fg-mute">
                {qualityColors[q.tier - 1]}
              </div>
              <div className="mt-1 text-[11px] text-fg-dim">{q.note}</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------- 03 · COLOR RULES -------- */

export function ColorRulesSection() {
  return (
    <Section
      id="color-rules"
      num="03 · Color"
      title="Where each colour lives."
      intro={
        <>
          The palette is small on purpose. Each colour has one job — if you're
          reaching for a sixth, propose it in the design channel first.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-5">
        {[
          {
            badge: "Do",
            tone: "do",
            h: "Use accent for the one thing that matters.",
            p: "A single CTA, a live status dot, a hazard pulse. Never for chrome or filler.",
          },
          {
            badge: "Do",
            tone: "do",
            h: "Match button colour to the surface it's on.",
            p: "Ink button on cream. Accent button on ink. Never accent on cream as a primary.",
          },
          {
            badge: "Don't",
            tone: "dont",
            h: "Don't tint paper to mean state.",
            p: "Hover, selected, and error are all done through stripe, ring, or fill — never by warming the background.",
          },
          {
            badge: "Don't",
            tone: "dont",
            h: "Don't bring in extra greys.",
            p: "The fg-dim / fg-mute / fg-faint ladder covers every reduced-emphasis need.",
          },
        ].map((rule) => (
          <div
            key={rule.h}
            className="grid grid-cols-[80px_1fr] items-start gap-4 border-b border-line py-4"
          >
            <div
              className={`rounded p-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${rule.tone === "do" ? "bg-quality-q5 text-ink" : "bg-quality-q1 text-cream"}`}
            >
              {rule.badge}
            </div>
            <div>
              <div className="mb-1 text-[14px] font-bold">{rule.h}</div>
              <div className="text-[13px] leading-[1.55] text-fg-dim">
                {rule.p}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------- 04 · TYPOGRAPHY -------- */

interface TypeRow {
  name: string;
  sub: string;
  sample: string;
  className: string;
  props: string;
}

const TYPE_ROWS: TypeRow[] = [
  {
    name: "DISPLAY",
    sub: "Fraunces 700",
    sample: "Know the road before you ride it.",
    className:
      "font-serif text-[76px] font-bold leading-[0.92] tracking-[-2px]",
    props: "76 / 0.92 / -2",
  },
  {
    name: "H1",
    sub: "Fraunces 700",
    sample: "Built with you.",
    className:
      "font-serif text-[48px] font-bold leading-none tracking-[-1.4px]",
    props: "48 / 1 / -1.4",
  },
  {
    name: "H2",
    sub: "Space Grotesk 800",
    sample: "Trip planner",
    className:
      "font-sans text-[30px] font-extrabold leading-[1.1] tracking-[-0.6px]",
    props: "30 / 1.1 / -0.6",
  },
  {
    name: "H3",
    sub: "Space Grotesk 800",
    sample: "Recent rides",
    className:
      "font-sans text-[22px] font-extrabold leading-[1.2] tracking-[-0.3px]",
    props: "22 / 1.2 / -0.3",
  },
  {
    name: "BODY",
    sub: "Space Grotesk 400",
    sample: "We ride every road we ship.",
    className: "font-sans text-[15px] leading-[1.55]",
    props: "15 / 1.55 / 0",
  },
  {
    name: "SMALL",
    sub: "Space Grotesk 500",
    sample: "12 segments updated this morning.",
    className: "font-sans text-[13px] font-medium leading-[1.5]",
    props: "13 / 1.5 / 0",
  },
  {
    name: "MONO",
    sub: "JetBrains Mono 500",
    sample: "186 km · 9:41 · 41°",
    className: "font-mono text-[12px] font-medium tracking-[0.5px]",
    props: "12 / 1 / +0.5",
  },
  {
    name: "STAMP",
    sub: "JetBrains Mono 700",
    sample: "BETA · LAUNCHING SUMMER",
    className: "font-mono text-[11px] font-bold uppercase tracking-[1.6px]",
    props: "11 / 1 / +1.6",
  },
  {
    name: "ITALIC",
    sub: "Fraunces 400 italic",
    sample: "Not read.",
    className: "font-serif text-[28px] italic",
    props: "28 / 1.1 / 0",
  },
];

export function TypeSection() {
  return (
    <Section
      id="type"
      num="04 · Type"
      title="Three families, nine roles."
      intro={
        <>
          Space Grotesk drives UI, JetBrains Mono carries stamps and numbers,
          Fraunces italic is reserved for marketing emotional beats. Don't
          italicise Space Grotesk — switch to Fraunces if a serif italic is
          really what you want.
        </>
      }
    >
      <div className="rounded-[14px] border border-line bg-cream">
        {TYPE_ROWS.map((row) => (
          <div
            key={row.name}
            className="grid grid-cols-[220px_1fr_160px] items-baseline gap-6 border-b border-line px-6 py-[22px] last:border-b-0"
          >
            <div>
              <div className="font-mono text-[11px] font-bold uppercase tracking-[1.4px]">
                {row.name}
              </div>
              <div className="mt-1 font-mono text-[10px] text-fg-dim">
                {row.sub}
              </div>
            </div>
            <div className={row.className}>{row.sample}</div>
            <div className="text-right font-mono text-[10px] leading-[1.7] text-fg-mute">
              {row.props}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------- 05 · SPACING & RADIUS -------- */

const SPACING = [
  { name: "--sp-1", val: 4 },
  { name: "--sp-2", val: 8 },
  { name: "--sp-3", val: 12 },
  { name: "--sp-4", val: 16 },
  { name: "--sp-5", val: 20 },
  { name: "--sp-6", val: 24 },
  { name: "--sp-8", val: 32 },
  { name: "--sp-10", val: 40 },
  { name: "--sp-12", val: 48 },
  { name: "--sp-16", val: 64 },
  { name: "--sp-20", val: 80 },
];

const RADII = [
  { name: "--r-xs", val: 4 },
  { name: "--r-sm", val: 8 },
  { name: "--r-md", val: 12 },
  { name: "--r-lg", val: 14 },
  { name: "--r-xl", val: 20 },
  { name: "--r-pill", val: 999, label: "999" },
];

export function SpaceSection() {
  return (
    <Section
      id="space"
      num="05 · Space"
      title="Spacing & radius."
      tone="tinted"
      intro={
        <>
          A strict 4-pt grid drives every gap and padding. Cards land between 18
          and 32; section gaps stay in the 24-28 range. Radii are tiered — pills
          get 999, cards get 14, devices get 38.
        </>
      }
    >
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="rounded-[14px] border border-line bg-cream">
          {SPACING.map((s) => (
            <div
              key={s.name}
              className="grid grid-cols-[100px_1fr_200px] items-center gap-4 border-b border-line px-4 py-2.5 font-mono text-[12px] last:border-b-0"
            >
              <span className="font-bold">{s.name}</span>
              <span>
                <span
                  className="block rounded-sm bg-ink"
                  style={{ width: s.val, height: 14 }}
                />
              </span>
              <span className="text-fg-dim">{s.val} px</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {RADII.map((r) => (
            <div
              key={r.name}
              className="relative grid aspect-square place-items-center border border-line bg-paper-2"
              style={{ borderRadius: r.val }}
            >
              <span className="absolute bottom-2 left-2.5 font-mono text-[10px] font-bold tracking-[1px]">
                {r.label ?? `${r.val}`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* -------- 06 · SHADOW & ELEVATION -------- */

export function ShadowSection() {
  return (
    <Section
      id="shadow"
      num="06 · Shadow"
      title="Almost flat, on purpose."
      intro={
        <>
          The product is paper-on-paper. Real shadow is reserved for the device
          mock and the floating Tweaks card. Everything else relies on 1 px
          hairlines and tone shifts.
        </>
      }
    >
      <div className="grid grid-cols-4 gap-4">
        <ShadowTile label="Flat" sub="default surface" />
        <ShadowTile
          label="Inner hairline"
          sub="1 px line"
          className="ring-1 ring-line ring-inset"
        />
        <ShadowTile
          label="Card lift"
          sub="0 8 24 / 0.08"
          className="shadow-[0_8px_24px_rgba(14,14,16,0.08)]"
        />
        <ShadowTile
          label="Floating"
          sub="0 24 60 / 0.20"
          className="shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
        />
      </div>
    </Section>
  );
}

function ShadowTile({
  label,
  sub,
  className,
}: {
  label: string;
  sub: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`grid aspect-[4/3] place-items-center rounded-xl border border-line bg-cream ${className ?? ""}`}
      >
        <span className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-fg-dim">
          {label}
        </span>
      </div>
      <SubStamp>{sub}</SubStamp>
    </div>
  );
}
