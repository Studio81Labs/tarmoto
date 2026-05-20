import { Section, SubStamp } from "../Section";
import {
  Card,
  Dot,
  Heading,
  Mono,
  Pill,
  QualityBars,
  Stamp,
  palette,
  qualityColors,
} from "@tarmoto/ui";

/* -------- 07 · ATOMS -------- */

interface AtomSpec {
  name: string;
  props: string;
  preview: React.ReactNode;
}

const ATOMS: AtomSpec[] = [
  {
    name: "Stamp",
    props: "JB Mono 700 · 11 px · 1.5 letter · upper",
    preview: <Stamp>ROUTE · DAY 1 OF 4</Stamp>,
  },
  {
    name: "Mono",
    props: "JB Mono · any size · 500–700",
    preview: (
      <Mono className="text-[22px] font-semibold tracking-[0.5px]">186 KM</Mono>
    ),
  },
  {
    name: "Heading",
    props: "Space Grotesk 800 · -0.5 letter · 1.05 lh",
    preview: <Heading size="lg">Alps Loop</Heading>,
  },
  {
    name: "Pill",
    props: "5/10 padding · 999 radius · 11 px · 700 weight",
    preview: (
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Pill>AI draft</Pill>
        <Pill variant="accent">
          <Dot color={palette.ink} size={6} />
          Active
        </Pill>
        <Pill variant="ghost">Following</Pill>
        <Pill variant="danger">Delete</Pill>
      </div>
    ),
  },
  {
    name: "Dot",
    props: "circle · 6–14 px · pairs with stamp or pill",
    preview: (
      <div className="flex items-center justify-center gap-4">
        <Dot color={palette.ink} size={8} />
        <Dot color={palette.accent} size={8} />
        <Dot color={qualityColors[4]} size={10} />
        <Dot color={qualityColors[0]} size={14} />
      </div>
    ),
  },
  {
    name: "QualityBars",
    props: "5 bars · filled q · palette-aware · 4–7 px width",
    preview: <QualityBars q={3} size={6} />,
  },
];

export function AtomsSection() {
  return (
    <Section
      id="atoms"
      num="07 · Atoms"
      title="The six pieces."
      tone="tinted"
      intro={
        <>
          Almost every screen in the app is composed from these. If a new screen
          seems to need a 7th atom, propose it in the design channel before
          introducing it — that's usually the moment a system breaks.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        {ATOMS.map((a) => (
          <Card key={a.name} padded={false}>
            <div className="flex min-h-[120px] items-center justify-center border-b border-line p-7">
              {a.preview}
            </div>
            <div className="border-t border-line bg-cream px-3.5 py-3">
              <div className="text-[12.5px] font-bold">{a.name}</div>
              <div className="mt-0.5 font-mono text-[10px] text-fg-dim">
                {a.props}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* -------- 08 · PILL -------- */

export function PillSection() {
  return (
    <Section
      id="pill"
      num="08 · Atom · Pill"
      title="Four variants. No more."
      intro={
        <>
          The pill carries every action and status in the app. Solid ink for
          primary, accent for emphasis, ghost (transparent + 1 px border-strong)
          for secondary, danger (transparent + Q1 border) for destructive. Size
          is fixed.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        <Card padded className="!p-7">
          <SubStamp>Variants</SubStamp>
          <div className="flex flex-wrap gap-2.5">
            <Pill>Push to phone →</Pill>
            <Pill variant="accent">
              <Dot color={palette.ink} size={6} />
              AI draft
            </Pill>
            <Pill variant="ghost">Export GPX</Pill>
            <Pill variant="danger">Delete</Pill>
          </div>

          <div className="mt-7">
            <SubStamp>With dot prefix</SubStamp>
            <div className="flex flex-wrap gap-2.5">
              <Pill variant="accent">
                <Dot color={palette.ink} size={6} />
                Active
              </Pill>
              <Pill variant="ghost">
                <Dot color={qualityColors[4]} size={6} />
                Opted in
              </Pill>
              <Pill>
                <Dot color={palette.accent} size={6} />
                Live
              </Pill>
            </div>
          </div>

          <div className="mt-7">
            <SubStamp>On dark surface</SubStamp>
            <div className="flex flex-wrap gap-2.5 rounded-[10px] bg-ink p-4.5 p-[18px]">
              <Pill variant="accent">Manage billing</Pill>
              <Pill variant="on-dark">Cancel</Pill>
            </div>
          </div>
        </Card>

        <Card padded className="!p-7">
          <SubStamp>Spec</SubStamp>
          <div className="overflow-hidden rounded-lg border border-line bg-cream">
            <SpecHead cols="120px 1fr 1fr">
              <span>Variant</span>
              <span>Background</span>
              <span>Border</span>
            </SpecHead>
            <SpecRow cols="120px 1fr 1fr">
              <span className="font-mono font-semibold">primary</span>
              <span className="text-fg-dim">--ink / fg cream</span>
              <span className="font-mono text-[11px] text-fg-dim">none</span>
            </SpecRow>
            <SpecRow cols="120px 1fr 1fr">
              <span className="font-mono font-semibold">accent</span>
              <span className="text-fg-dim">--accent / fg ink</span>
              <span className="font-mono text-[11px] text-fg-dim">none</span>
            </SpecRow>
            <SpecRow cols="120px 1fr 1fr">
              <span className="font-mono font-semibold">ghost</span>
              <span className="text-fg-dim">transparent / fg ink</span>
              <span className="font-mono text-[11px] text-fg-dim">
                1 px line-strong
              </span>
            </SpecRow>
            <SpecRow cols="120px 1fr 1fr" last>
              <span className="font-mono font-semibold">danger</span>
              <span className="text-fg-dim">transparent / fg Q1</span>
              <span className="font-mono text-[11px] text-fg-dim">1 px Q1</span>
            </SpecRow>
          </div>

          <div className="mt-4">
            <SubStamp>Geometry</SubStamp>
            <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
              <li>
                Padding <Mono className="text-ink">5 / 10</Mono>
              </li>
              <li>
                Radius <Mono className="text-ink">999</Mono>
              </li>
              <li>
                Text <Mono className="text-ink">11 px / 700</Mono>
              </li>
              <li>
                Gap if dot prefix <Mono className="text-ink">6 px</Mono>
              </li>
              <li>No hover scale, no shadow</li>
            </ul>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* Shared spec table helpers, used by §08, §17, §18, §22 etc. */
export function SpecHead({
  cols,
  children,
}: {
  cols: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid items-center gap-3 bg-paper px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1.2px] text-fg-dim"
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}

export function SpecRow({
  cols,
  children,
  last,
}: {
  cols: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`grid items-center gap-3 px-4 py-2.5 text-[12.5px] ${last ? "" : "border-b border-line"}`}
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}

/* -------- 10 · QUALITYBARS -------- */

export function QualityBarsSection() {
  return (
    <Section
      id="qbars"
      num="10 · Atom · QualityBars"
      title="The signature glyph."
      intro={
        <>
          Tarmoto's signature is the five-bar quality marker. Always five bars,
          always filled left-to-right, always palette-aware. Use it wherever a
          number ≥ 3 is about road or ride quality. Don't recolor it. Don't
          reorder it.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Card padded>
          <SubStamp>Sizes</SubStamp>
          <div className="flex flex-col gap-3.5">
            {[3, 4, 5, 7].map((size, i) => (
              <div key={size} className="flex items-center gap-3.5">
                <QualityBars q={(i + 2) as 2 | 3 | 4 | 5} size={size} />
                <Mono className="text-[11px] text-fg-dim">
                  size {size} ·{" "}
                  {["table rows", "card meta", "default", "feature card"][i]}
                </Mono>
              </div>
            ))}
          </div>
        </Card>
        <Card padded>
          <SubStamp>Quality fills</SubStamp>
          <div className="flex flex-col gap-2.5">
            {[1, 2, 3, 4, 5].map((q) => (
              <div key={q} className="flex items-center gap-3.5">
                <QualityBars q={q as 1 | 2 | 3 | 4 | 5} size={5} />
                <Mono className="text-[11px]">
                  q={q} · Q{q} only
                </Mono>
              </div>
            ))}
          </div>
        </Card>
        <Card padded>
          <SubStamp>Rules</SubStamp>
          <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
            <li>Filled bars take the colour of q-stop (all same colour)</li>
            <li>Unfilled bars are ink @ 8%</li>
            <li>
              Gap is always <Mono className="text-ink">2 px</Mono>
            </li>
            <li>
              Bar radius is <Mono className="text-ink">1.5 px</Mono>
            </li>
            <li>
              Height is <Mono className="text-ink">size × 2.2</Mono>
            </li>
            <li>
              On dark surfaces, unfilled flip to{" "}
              <Mono className="text-ink">cream @ 12%</Mono> via{" "}
              <Mono className="text-ink">onDark</Mono>
            </li>
          </ul>
        </Card>
      </div>
    </Section>
  );
}
