import { Section, SubStamp } from "../Section";
import { Card, Mono, Stamp, palette, qualityColors } from "@tarmoto/ui";
import { CodeBlock, ColorDot, TokenTable } from "./_shared";

/* ============================================================
 * 01 · COLOR SURFACES
 * ============================================================ */

interface Swatch {
  name: string;
  varName: string;
  hex: string;
  chip: React.ReactNode;
  label: string;
  labelOnDark?: boolean;
}

function makeChip(bg: string) {
  return <div className="h-[110px] w-full" style={{ background: bg }} />;
}

function makeFgChip() {
  return (
    <div
      className="h-[110px] w-full"
      style={{
        background: "linear-gradient(180deg, #F5EFE6 50%, #0E0E10 50%)",
      }}
    />
  );
}

function makeAlphaChip() {
  return (
    <div
      className="relative h-[110px] w-full"
      style={{ background: palette.cream }}
    >
      <div className="absolute inset-0 flex flex-col justify-center gap-1.5 px-4.5 p-[18px]">
        <div className="h-1 w-4/5 bg-ink" />
        <div
          className="h-1 w-3/5"
          style={{ background: "rgba(14,14,16,0.62)" }}
        />
        <div
          className="h-1 w-[70%]"
          style={{ background: "rgba(14,14,16,0.40)" }}
        />
        <div
          className="h-1 w-2/5"
          style={{ background: "rgba(14,14,16,0.22)" }}
        />
      </div>
    </div>
  );
}

const SURFACES: Swatch[] = [
  {
    name: "Cream",
    varName: "--cream / --bg",
    hex: "#F5EFE6",
    chip: makeChip("#F5EFE6"),
    label: "CANVAS",
  },
  {
    name: "Paper",
    varName: "--paper / --bg-raised",
    hex: "#EDE6DA",
    chip: makeChip("#EDE6DA"),
    label: "RAISED",
  },
  {
    name: "Paper 2",
    varName: "--paper-2 / --bg-sunken",
    hex: "#E5DBCB",
    chip: makeChip("#E5DBCB"),
    label: "SUNKEN",
  },
  {
    name: "Ink",
    varName: "--ink / --surface-inverse",
    hex: "#0E0E10",
    chip: makeChip("#0E0E10"),
    label: "INVERSE",
    labelOnDark: true,
  },
  {
    name: "Tarmac",
    varName: "--tarmac / --surface-dark",
    hex: "#2B2C30",
    chip: makeChip("#2B2C30"),
    label: "SOFT INK",
    labelOnDark: true,
  },
  {
    name: "Accent",
    varName: "--accent",
    hex: "#FF6A1A · tweakable",
    chip: makeChip("#FF6A1A"),
    label: "ACCENT",
  },
  {
    name: "Foreground",
    varName: "--fg / --fg-on-dark",
    hex: "Ink on cream · cream on ink",
    chip: makeFgChip(),
    label: "",
  },
  {
    name: "Text alphas",
    varName: "--fg · --fg-dim · --fg-mute · --fg-faint",
    hex: "1.00 · 0.62 · 0.40 · 0.22",
    chip: makeAlphaChip(),
    label: "",
  },
];

function SwatchCard({ name, varName, hex, chip, label, labelOnDark }: Swatch) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-cream">
      <div className="relative">
        {chip}
        {label && (
          <span
            className={`absolute bottom-2 left-3 font-mono text-[10px] font-bold uppercase tracking-[1px] ${
              labelOnDark ? "text-cream" : "text-ink"
            }`}
          >
            {label}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-line px-3.5 py-3">
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
          Tarmoto is a paper interface. Cream is the canvas, ink is the speaker,
          accent is the spark. Surfaces step from{" "}
          <span className="font-mono">--cream</span> outward (lighter air) and
          inward (deeper paper). Inverse surfaces use{" "}
          <span className="font-mono">--ink</span>. Anything that isn't on this
          list isn't a Tarmoto color — escalate before adding one.
        </>
      }
    >
      <div className="mb-7 grid grid-cols-4 gap-3.5">
        {SURFACES.map((s) => (
          <SwatchCard key={s.name} {...s} />
        ))}
      </div>

      <TokenTable
        columns={[
          { label: "", size: "24px" },
          { label: "Token", size: "140px" },
          { label: "Use for", size: "1fr" },
          { label: "Alpha", size: "80px" },
          { label: "Value", size: "140px" },
        ]}
        rows={[
          [
            <ColorDot color="#F5EFE6" />,
            <Mono className="font-semibold">--cream</Mono>,
            <span className="text-fg-dim">
              Default app canvas. Cards on dark surfaces.
            </span>,
            <Mono className="text-fg-mute">1.00</Mono>,
            <Mono className="text-fg-mute">#F5EFE6</Mono>,
          ],
          [
            <ColorDot color="#EDE6DA" />,
            <Mono className="font-semibold">--paper</Mono>,
            <span className="text-fg-dim">
              Right rails, segmented backgrounds, inner cells.
            </span>,
            <Mono className="text-fg-mute">1.00</Mono>,
            <Mono className="text-fg-mute">#EDE6DA</Mono>,
          ],
          [
            <ColorDot color="#E5DBCB" />,
            <Mono className="font-semibold">--paper-2</Mono>,
            <span className="text-fg-dim">Cards on cream, deep wells.</span>,
            <Mono className="text-fg-mute">1.00</Mono>,
            <Mono className="text-fg-mute">#E5DBCB</Mono>,
          ],
          [
            <ColorDot color="#0E0E10" />,
            <Mono className="font-semibold">--ink</Mono>,
            <span className="text-fg-dim">
              Text, nav rail, primary buttons, active state.
            </span>,
            <Mono className="text-fg-mute">1.00</Mono>,
            <Mono className="text-fg-mute">#0E0E10</Mono>,
          ],
          [
            <ColorDot color="rgba(14,14,16,0.62)" />,
            <Mono className="font-semibold">--fg-dim</Mono>,
            <span className="text-fg-dim">
              Secondary text. Sub-labels under titles.
            </span>,
            <Mono className="text-fg-mute">0.62</Mono>,
            <Mono className="text-fg-mute">ink @ 62%</Mono>,
          ],
          [
            <ColorDot color="rgba(14,14,16,0.40)" />,
            <Mono className="font-semibold">--fg-mute</Mono>,
            <span className="text-fg-dim">Tertiary text. Mono metadata.</span>,
            <Mono className="text-fg-mute">0.40</Mono>,
            <Mono className="text-fg-mute">ink @ 40%</Mono>,
          ],
          [
            <ColorDot color="rgba(14,14,16,0.10)" />,
            <Mono className="font-semibold">--line</Mono>,
            <span className="text-fg-dim">
              Card &amp; section borders. Hairlines.
            </span>,
            <Mono className="text-fg-mute">0.10</Mono>,
            <Mono className="text-fg-mute">ink @ 10%</Mono>,
          ],
          [
            <ColorDot color="rgba(14,14,16,0.22)" />,
            <Mono className="font-semibold">--line-strong</Mono>,
            <span className="text-fg-dim">
              Floating toolbars. Ghost button borders.
            </span>,
            <Mono className="text-fg-mute">0.22</Mono>,
            <Mono className="text-fg-mute">ink @ 22%</Mono>,
          ],
          [
            <ColorDot color="#FF6A1A" />,
            <Mono className="font-semibold">--accent</Mono>,
            <span className="text-fg-dim">
              One per screen. Highlight number, primary CTA on dark, hazard.
            </span>,
            <Mono className="text-fg-mute">1.00</Mono>,
            <Mono className="text-fg-mute">#FF6A1A</Mono>,
          ],
        ]}
      />
    </Section>
  );
}

/* ============================================================
 * 02 · QUALITY SCALE — three palettes
 * ============================================================ */

const TRAFFIC = ["#E05A3C", "#F0A03C", "#E8D66A", "#C7D36A", "#6FD38A"];
const MUTED = ["#C26A5E", "#C9A06E", "#C9BA7E", "#9EB07E", "#7EA88E"];
const MONO = ["#8A8070", "#9A9080", "#AAA090", "#BAB0A0", "#CAC0B0"];

function PaletteCard({
  stamp,
  colors,
  caption,
}: {
  stamp: string;
  colors: string[];
  caption: string;
}) {
  return (
    <Card>
      <Stamp>{stamp}</Stamp>
      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {colors.map((c, i) => (
          <div
            key={i}
            className="aspect-square rounded-md"
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="mt-2.5 grid grid-cols-5 gap-1.5 font-mono text-[10px] text-fg-dim">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n}>Q{n}</span>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-[1.5] text-fg-dim">{caption}</p>
    </Card>
  );
}

export function QualitySection() {
  return (
    <Section
      id="quality"
      num="02 · Color · Domain"
      title="Road quality scale."
      tone="tinted"
      intro={
        <>
          Five-stop ordinal scale, used for road segments, ride scores, day
          quality, and any product surface that asks "how good is this?". Three
          palettes exist; switch via the{" "}
          <span className="font-mono">palette</span> tweak. Default is{" "}
          <span className="font-mono">traffic</span>. The scale is{" "}
          <strong>always 1 → 5 left to right</strong>: low/bad → high/good.
        </>
      }
    >
      <div className="mb-7 grid grid-cols-3 gap-3.5">
        <PaletteCard
          stamp="Traffic · default"
          colors={TRAFFIC}
          caption="Red → green ordinal. Maximum semantic punch. Use on map polylines, hazards, summary scores."
        />
        <PaletteCard
          stamp="Muted · paper"
          colors={MUTED}
          caption="Earth-toned. Use when too many quality bars on screen would oversaturate (route lists, history grids)."
        />
        <PaletteCard
          stamp="Mono · grayscale"
          colors={MONO}
          caption="Accessibility & print. Quality encoded by ordering only — pair with bar count, never alone."
        />
      </div>

      <TokenTable
        columns={[
          { label: "", size: "24px" },
          { label: "Token", size: "100px" },
          { label: "Semantic", size: "1fr" },
          { label: "Stop", size: "60px" },
          { label: "Value", size: "100px" },
        ]}
        rows={qualityColors.map((color, i) => {
          const desc = [
            "Avoid — broken surface, dangerous hazard, < 2.0 score",
            "Rough — passable, ride with caution",
            "OK — meets baseline. Don't make a trip out of it.",
            "Great — proudly include in itineraries",
            "Hero — Tarmoto-defining road. Star segment.",
          ][i];
          return [
            <ColorDot color={color} />,
            <Mono className="font-semibold">--q{i + 1}</Mono>,
            <span className="text-fg-dim">{desc}</span>,
            <Mono className="text-fg-mute">Q{i + 1}</Mono>,
            <Mono className="text-fg-mute">{color}</Mono>,
          ];
        })}
      />
    </Section>
  );
}

/* ============================================================
 * 03 · COLOR RULES — accent budget
 * ============================================================ */

export function ColorRulesSection() {
  return (
    <Section
      id="color-rules"
      num="03 · Color · Rules"
      title="The accent budget."
      intro={
        <>
          Orange is loud, and Tarmoto is quiet. Spend it deliberately. Every
          screen has one accent target; everything else lives in ink, paper, or
          the quality scale. If you find yourself reaching for accent twice on a
          screen, the second use is wrong.
        </>
      }
    >
      <ColorRulesGrid />
    </Section>
  );
}

function ColorRulesGrid() {
  const rules: Array<{
    kind: "do" | "dont" | "tip";
    title: React.ReactNode;
    body: React.ReactNode;
  }> = [
    {
      kind: "do",
      title: "Use accent for the one number that matters.",
      body: "Hero metric, the day count the AI just changed, the user's own score. One per screen, ideally one per fold.",
    },
    {
      kind: "do",
      title: "Use accent for primary CTAs on dark surfaces.",
      body: "Ink-on-cream uses ink-on-cream CTAs. Cream-on-ink uses accent-on-ink CTAs.",
    },
    {
      kind: "do",
      title: "Use accent for hazard pins and warnings only.",
      body: "Accent doubles as the danger color in this product — never confuse it with success.",
    },
    {
      kind: "tip",
      title: "Active toggle handle = accent on ink.",
      body: "Off state = cream on grey. The thumb is a tiny accent moment.",
    },
    {
      kind: "dont",
      title: "Don't tint backgrounds with accent.",
      body: "No orange cards, no orange wells, no orange section dividers. The page is cream.",
    },
    {
      kind: "dont",
      title: "Don't color body text with accent.",
      body: (
        <>
          Accent is reserved for stamps, single numbers, and pins. Body text is
          ink or <span className="font-mono">--fg-dim</span>.
        </>
      ),
    },
    {
      kind: "dont",
      title: "Don't mix quality palette with accent on the same chart.",
      body: "Pick one semantic system per chart. If you're showing q1–q5 already, the highlight number stays ink.",
    },
    {
      kind: "tip",
      title: "Collaborator cursors get their own hue.",
      body: (
        <>
          <span className="font-mono" style={{ color: "#6FD38A" }}>
            #6FD38A
          </span>{" "}
          /{" "}
          <span className="font-mono" style={{ color: "#6EB4E8" }}>
            #6EB4E8
          </span>{" "}
          /{" "}
          <span className="font-mono" style={{ color: "#C28AE8" }}>
            #C28AE8
          </span>{" "}
          — these are people, not data. They never apply to non-human UI.
        </>
      ),
    },
  ];
  // Source HTML interleaves Do's on left, Don'ts on right. Mirror.
  const left = rules.filter((_r, i) => i < 4);
  const right = rules.filter((_r, i) => i >= 4);
  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        {left.map((r, i) => (
          <RuleRow key={i} {...r} />
        ))}
      </div>
      <div>
        {right.map((r, i) => (
          <RuleRow key={i} {...r} />
        ))}
      </div>
    </div>
  );
}

function RuleRow({
  kind,
  title,
  body,
}: {
  kind: "do" | "dont" | "tip";
  title: React.ReactNode;
  body: React.ReactNode;
}) {
  const badge = {
    do: { cls: "bg-quality-q5 text-ink", label: "Do" },
    dont: { cls: "bg-quality-q1 text-cream", label: "Don't" },
    tip: { cls: "bg-ink text-cream", label: "Tip" },
  }[kind];
  return (
    <div className="grid grid-cols-[64px_1fr] items-start gap-4 border-b border-line py-4 last:border-b-0">
      <div
        className={`rounded p-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${badge.cls}`}
      >
        {badge.label}
      </div>
      <div>
        <div className="mb-1 text-[14px] font-bold">{title}</div>
        <div className="text-[13px] leading-[1.55] text-fg-dim">{body}</div>
      </div>
    </div>
  );
}

/* ============================================================
 * 04 · TYPOGRAPHY — 3 family cards + 9-row type table + pairing rules
 * ============================================================ */

interface TypeRow {
  name: string;
  sub: string;
  sample: React.ReactNode;
  className: string;
  props: string;
}

const TYPE_ROWS: TypeRow[] = [
  {
    name: "ty-display",
    sub: "Hero · marketing",
    sample: "Tarmoto Alps Loop",
    className:
      "font-serif text-[88px] font-bold leading-[0.94] tracking-[-3px]",
    props: "Fraunces 700\n108 / 0.94\n-3 letter",
  },
  {
    name: "ty-h1",
    sub: "Page openers",
    sample: "Routes from riders you follow",
    className:
      "font-serif text-[56px] font-bold leading-none tracking-[-1.6px]",
    props: "Fraunces 700\n64 / 1.0\n-1.8 letter",
  },
  {
    name: "ty-h2",
    sub: "View titles",
    sample: "April 2026 · 12 rides",
    className:
      "font-sans text-[32px] font-extrabold leading-[1.1] tracking-[-0.6px]",
    props: "Space Grotesk 800\n32 / 1.1\n-0.6 letter",
  },
  {
    name: "ty-h3",
    sub: "Section titles in panels",
    sample: "Tune the AI draft",
    className:
      "font-sans text-[22px] font-extrabold leading-[1.2] tracking-[-0.3px]",
    props: "Space Grotesk 800\n22 / 1.2\n-0.3 letter",
  },
  {
    name: "ty-body",
    sub: "Default running text",
    sample:
      "Stelvio + Umbrail + Bernina. All resurfaced in May. Skip the coffee at Tibet Hütte — queue is brutal.",
    className: "font-sans text-[15px] leading-[1.55] text-fg-dim max-w-[50ch]",
    props: "Space Grotesk 400\n15 / 1.55",
  },
  {
    name: "ty-small",
    sub: "Sub-labels, captions",
    sample: "Changes re-run Fun Zone discovery live.",
    className: "font-sans text-[13px] font-medium leading-[1.5] text-fg-dim",
    props: "Space Grotesk 500\n13 / 1.5",
  },
  {
    name: "ty-mono",
    sub: "Numbers in flow",
    sample: "186 KM · 4h 12m · 48 turns · ↗ 1,536 m",
    className: "font-mono text-[12px] font-medium tracking-[0.5px]",
    props: "JB Mono 500\n12 / 1.0\n0.5 letter",
  },
  {
    name: "ty-stamp",
    sub: "Section labels",
    sample: "ROUTE · DAY 1 OF 4",
    className:
      "font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-fg-dim",
    props: "JB Mono 700\n11 / 1.0\n1.5 letter · upper",
  },
  {
    name: "ty-italic",
    sub: "Editorial inline emphasis",
    sample: (
      <span>
        <em>everything for the ride</em>
      </span>
    ),
    className: "font-serif text-[28px] italic",
    props: "Fraunces 400 italic\nany size",
  },
];

export function TypeSection() {
  return (
    <Section
      id="type"
      num="04 · Typography"
      title="Three families, three jobs."
      intro={
        <>
          Fraunces is the editorial voice — used at H1 and italic call-outs.
          Space Grotesk is the working font — UI, body, headings inside the app.
          JetBrains Mono is the instrument — metadata, stamps, numbers, route
          distances. Never substitute one for another.
        </>
      }
    >
      <div className="mb-9 grid grid-cols-3 gap-3.5">
        <FamilyCard
          stamp="Editorial"
          aa="font-serif font-bold"
          name="Fraunces"
          axes="9..144 · 400 · 700 · italic"
          body="Hero titles, marketing surfaces, italic emphasis inside the app. Optical size shines at 60+ px."
        />
        <FamilyCard
          stamp="Working"
          aa="font-sans font-extrabold"
          name="Space Grotesk"
          axes="400 · 500 · 600 · 700 · 800"
          body="UI labels, body copy, in-app headings. 14–32 px is the sweet spot. Goes to 800 weight without breaking."
        />
        <FamilyCard
          stamp="Instrument"
          aa="font-mono font-bold"
          name="JetBrains Mono"
          axes="400 · 500 · 700"
          body="Numbers, distances, stamps, table cells. Anything that should feel measured."
        />
      </div>

      <Card padded={false} className="overflow-hidden">
        {TYPE_ROWS.map((row, i) => (
          <div
            key={row.name}
            className={`grid grid-cols-[220px_1fr_140px] items-baseline gap-6 px-7 py-[22px] ${
              i < TYPE_ROWS.length - 1 ? "border-b border-line" : ""
            }`}
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
            <div className="whitespace-pre-line text-right font-mono text-[10px] leading-[1.55] text-fg-mute">
              {row.props}
            </div>
          </div>
        ))}
      </Card>

      <div className="mt-7">
        <SubStamp>Pairing rules</SubStamp>
        <div className="grid grid-cols-3 gap-3.5">
          <Card>
            <div className="mb-1.5 text-[14px] font-bold">Stamp + Heading</div>
            <Stamp>RIDE HISTORY</Stamp>
            <div className="mt-1 font-sans text-[24px] font-extrabold tracking-[-0.4px]">
              April 2026 · 12 rides
            </div>
            <p className="mt-2 text-[12px] text-fg-dim">
              Stamp + 4 px gap + sans heading. The pattern for every screen
              header.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 text-[14px] font-bold">Number + Unit</div>
            <div className="flex items-baseline gap-1.5">
              <div className="text-[40px] font-extrabold leading-none tracking-[-1px]">
                1,284
              </div>
              <Mono className="text-[11px] text-fg-dim">KM</Mono>
            </div>
            <p className="mt-2 text-[12px] text-fg-dim">
              Big sans-serif number, small mono unit. Never the other way
              around.
            </p>
          </Card>
          <Card>
            <div className="mb-1.5 text-[14px] font-bold">
              Body + Inline mono
            </div>
            <div className="text-[13px] text-fg-dim">
              <Mono className="font-bold text-ink">610</Mono> km ·{" "}
              <Mono className="font-bold text-ink">6</Mono> passes ·{" "}
              <Mono className="font-bold text-ink">4</Mono> days
            </div>
            <p className="mt-2 text-[12px] text-fg-dim">
              Inline numbers borrow mono. Bold + ink keeps them from
              disappearing into the dim sentence.
            </p>
          </Card>
        </div>
      </div>
    </Section>
  );
}

function FamilyCard({
  stamp,
  aa,
  name,
  axes,
  body,
}: {
  stamp: string;
  aa: string;
  name: string;
  axes: string;
  body: string;
}) {
  return (
    <Card>
      <Stamp>{stamp}</Stamp>
      <div className={`mt-1.5 text-[88px] leading-[0.9] tracking-[-2px] ${aa}`}>
        Aa
      </div>
      <div className="mt-3 text-[14px] font-bold">{name}</div>
      <Mono className="block text-[11px] text-fg-dim">{axes}</Mono>
      <p className="mt-2.5 text-[12px] leading-[1.5] text-fg-dim">{body}</p>
    </Card>
  );
}

/* ============================================================
 * 05 · SPACING & RADIUS — twin cards + 3 sub-cards
 * ============================================================ */

const SPACING = [
  { name: "--sp-1", val: 4, use: "4 px · hair gap" },
  { name: "--sp-2", val: 8, use: "8 px · tight grouping" },
  { name: "--sp-3", val: 12, use: "12 px · default gap" },
  { name: "--sp-4", val: 16, use: "16 px · card padding" },
  { name: "--sp-5", val: 20, use: "20 px · row gutter" },
  { name: "--sp-6", val: 24, use: "24 px · section padding" },
  { name: "--sp-8", val: 32, use: "32 px · between cards" },
  { name: "--sp-10", val: 40, use: "40 px · column gutter" },
  { name: "--sp-12", val: 48, use: "48 px · section vertical" },
];

const RADII = [
  { name: "--r-xs · 4", val: 4, ratio: { w: "60%", h: "60%" } },
  { name: "--r-sm · 8", val: 8, ratio: { w: "60%", h: "60%" } },
  { name: "--r-md · 12", val: 12, ratio: { w: "60%", h: "60%" } },
  { name: "--r-lg · 16", val: 16, ratio: { w: "60%", h: "60%" } },
  { name: "--r-xl · 20", val: 20, ratio: { w: "60%", h: "60%" } },
  { name: "--r-pill · ∞", val: 999, ratio: { w: "60%", h: "30%" } },
  { name: "--r-device · 38", val: 38, ratio: { w: "60%", h: "80%" } },
  { name: "circle", val: 999, ratio: { w: "60%", h: "60%" }, circle: true },
];

export function SpaceSection() {
  return (
    <Section
      id="space"
      num="05 · Spacing & radius"
      title="4 pt grid, two densities."
      tone="tinted"
      intro={
        <>
          Everything sizes on a 4 pt grid. Cards default to 14–18 px padding;
          comfortable rows breathe at 14 px gap, compact rows at 10 px. Radii
          are codified — never invent a new one mid-component.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        {/* Spacing scale */}
        <Card padded={false} className="overflow-hidden">
          <div className="px-4 pb-3 pt-4">
            <Stamp>Spacing scale</Stamp>
          </div>
          {SPACING.map((s) => (
            <div
              key={s.name}
              className="grid grid-cols-[80px_1fr_180px] items-center gap-3 border-t border-line px-4 py-2 font-mono text-[12px]"
            >
              <span className="font-bold">{s.name}</span>
              <div
                className="rounded-sm bg-ink"
                style={{ width: s.val, height: 14 }}
              />
              <span className="text-fg-dim">{s.use}</span>
            </div>
          ))}
        </Card>

        {/* Radii */}
        <Card padded={false} className="overflow-hidden">
          <div className="px-4 pb-3 pt-4">
            <Stamp>Radii</Stamp>
          </div>
          <div className="grid grid-cols-4 gap-px bg-line">
            {RADII.map((r) => (
              <div
                key={r.name}
                className="relative flex aspect-square flex-col items-center justify-center gap-2 bg-cream"
              >
                <div
                  className="bg-ink"
                  style={{
                    width: r.ratio.w,
                    height: r.ratio.h,
                    borderRadius: r.circle ? "50%" : r.val,
                  }}
                />
                <span className="absolute bottom-2 font-mono text-[10px] tracking-[0.5px] text-fg-dim">
                  {r.name}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-line px-4 py-3.5 text-[12px] text-fg-dim">
            Rule: a card holding pill-shaped chips uses{" "}
            <Mono className="text-ink">--r-lg</Mono> (14). A pill inside that
            card uses <Mono className="text-ink">--r-pill</Mono>. Never two of
            the same radius nested.
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3.5">
        <Card>
          <Stamp>Card padding map</Stamp>
          <ul className="mt-2.5 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
            <li>
              <Mono className="text-ink">12 px</Mono> — compact density rows
            </li>
            <li>
              <Mono className="text-ink">14 px</Mono> — Road Preview cards
            </li>
            <li>
              <Mono className="text-ink">18 px</Mono> — default card padding
            </li>
            <li>
              <Mono className="text-ink">22 px</Mono> — settings cards (Account)
            </li>
            <li>
              <Mono className="text-ink">28 px</Mono> — page heroes only
            </li>
          </ul>
        </Card>
        <Card>
          <Stamp>Section spacing</Stamp>
          <ul className="mt-2.5 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
            <li>
              View padding: <Mono className="text-ink">24 / 28</Mono> top &amp;
              sides
            </li>
            <li>
              Header → grid: <Mono className="text-ink">20–22</Mono>
            </li>
            <li>
              Card grid gap: <Mono className="text-ink">14–20</Mono>
            </li>
            <li>
              Card → next card: <Mono className="text-ink">10–14</Mono>
            </li>
            <li>
              Sidebar item gap: <Mono className="text-ink">2 px</Mono>
            </li>
          </ul>
        </Card>
        <Card>
          <Stamp>Densities</Stamp>
          <p className="mt-2.5 text-[13px] leading-[1.55] text-fg-dim">
            <strong>Comfortable</strong> is default — 14 px card padding, 10 px
            gap, 52 px sparkline.
          </p>
          <p className="mt-3 text-[13px] leading-[1.55] text-fg-dim">
            <strong>Compact</strong> compresses to 12 / 8 / 36. Use for
            power-user surfaces; never for marketing or hero contexts.
          </p>
        </Card>
      </div>
    </Section>
  );
}

/* ============================================================
 * 06 · SHADOW & ELEVATION — 4-up tiles
 * ============================================================ */

export function ShadowSection() {
  return (
    <Section
      id="shadow"
      num="06 · Shadow"
      title="Elevation is rare."
      intro={
        <>
          Most surfaces in Tarmoto are flush — borders, not drop shadows, do the
          separating work. Shadows are reserved for floating affordances over
          the map (toolbars, day timeline) and the Tweaks panel. Three steps
          only.
        </>
      }
    >
      <div className="grid grid-cols-4 gap-4">
        <ShadowTile
          label="Flat"
          tokenLabel="none"
          sub="Default for cards on cream."
        />
        <ShadowTile
          label="Hairline"
          tokenLabel="inset 0 0 0 1px line"
          sub="Same job as border. Use one or the other."
          className="ring-1 ring-line ring-inset"
        />
        <ShadowTile
          label="Card"
          tokenLabel="--shadow-card"
          sub="0 8 24 ink @ 8%. Map floaters only."
          className="shadow-[0_8px_24px_rgba(14,14,16,0.08)]"
        />
        <ShadowTile
          label="Lift"
          tokenLabel="--shadow-lift"
          sub="0 24 60 ink @ 20%. Tweaks panel, dialogs."
          className="shadow-[0_24px_60px_rgba(14,14,16,0.2)]"
        />
      </div>
    </Section>
  );
}

function ShadowTile({
  label,
  tokenLabel,
  sub,
  className,
}: {
  label: string;
  tokenLabel: string;
  sub: string;
  className?: string;
}) {
  return (
    <div>
      <div
        className={`grid aspect-[4/3] place-items-center rounded-xl bg-cream ${className ?? "border border-line"}`}
      />
      <div className="mt-2.5">
        <Stamp>{label}</Stamp>
        <div className="mt-1 text-[13px] font-bold">{tokenLabel}</div>
        <Mono className="mt-0.5 block text-[10px] text-fg-dim">{sub}</Mono>
      </div>
    </div>
  );
}

// Re-export for cross-file usage if needed in future.
export { palette, qualityColors };
