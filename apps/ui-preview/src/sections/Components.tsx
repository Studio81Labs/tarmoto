import { useState } from "react";
import { Section, SubStamp } from "../Section";
import {
  Card,
  DataTable,
  MetricTile,
  Mono,
  NavRail,
  NavRailContribution,
  Pill,
  QualityBars,
  RoadPreviewCard,
  Stamp,
  TweaksPanel,
  DEFAULT_TWEAKS,
  type TweaksTokens,
} from "@tarmoto/ui";
import { SpecHead, SpecRow } from "./Atoms";
import { CC, CK, CN, CodeBlock, CS } from "./_shared";

/* -------- 11 · CARD -------- */

export function CardSection() {
  return (
    <Section
      id="card"
      num="11 · Component · Card"
      title="Three flavors of card."
      tone="tinted"
      intro={
        <>
          Default is cream-on-cream with a hairline. Tinted lives on cream too
          but uses paper fill — for inner cells inside cards. Inverse is ink
          fill, used as a "hero" call-out once per view max.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <Stamp>Default</Stamp>
          <div className="mt-1.5 text-[17px] font-bold">Distance by month</div>
          <Mono className="mt-1 block text-[11px] text-fg-dim">
            Last 12 months
          </Mono>
          <div className="mt-3.5 h-[60px] rounded-lg bg-paper" />
          <div className="mt-3.5">
            <CodeBlock>
              {`background: --cream\n`}
              {`border: 1 px --line\n`}
              {`radius: 14\n`}
              {`padding: 18`}
            </CodeBlock>
          </div>
        </Card>
        <Card variant="paper-2">
          <Stamp>Tinted · sunken</Stamp>
          <div className="mt-1.5 text-[17px] font-bold">
            Notification preferences
          </div>
          <Mono className="mt-1 block text-[11px] text-fg-dim">
            Settings inner row
          </Mono>
          <div className="mt-3.5 h-[60px] rounded-lg border border-line bg-cream" />
          <div className="mt-3.5">
            <CodeBlock>
              {`background: --paper-2\n`}
              {`border: 1 px --line\n`}
              {`nested into another card`}
            </CodeBlock>
          </div>
        </Card>
        <Card variant="ink">
          <Stamp tone="accent">Inverse · hero</Stamp>
          <div className="mt-1.5 text-[17px] font-bold">Active challenge</div>
          <Mono className="mt-1 block text-[11px] text-cream/60">
            Once per view
          </Mono>
          <div className="mt-3.5 h-[60px] rounded-lg bg-cream/6" />
          <div className="mt-3.5">
            <CodeBlock tone="tarmac">
              {`background: --ink\n`}
              {`fg: --cream\n`}
              {`stamp color: --accent`}
            </CodeBlock>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* -------- 12 · METRIC TILE -------- */

export function MetricSection() {
  return (
    <Section
      id="metric"
      num="12 · Component · Metric tile"
      title="The KPI brick."
      intro={
        <>
          Always 4 across in a row on Ride History. Always: stamp → big number →
          unit → delta. The accent number is for the one metric the user just
          changed or the one we're proudest of — never two.
        </>
      }
    >
      <div className="mb-6 grid grid-cols-4 gap-3.5">
        <MetricTile
          variant="ink"
          accentNumber
          label="Distance"
          value="1,284"
          unit="km"
          unitPosition="after"
          delta="+18% vs March"
        />
        <MetricTile
          label="Ride time"
          value="32"
          unit="hrs"
          unitPosition="after"
          delta="+4h vs March"
        />
        <MetricTile
          label="New roads"
          value="47"
          unit="discovered"
          unitPosition="after"
          delta="+12 this month"
        />
        <MetricTile
          variant="paper"
          accentNumber
          label="Lean angle"
          value="41°"
          unit="max"
          unitPosition="after"
          delta="Passo Gavia"
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Anatomy callout — a labelled MetricTile with arrows.
         * Source `.anatomy` has 40 px padding + the metric in normal flow
         * with `margin: 60px auto;` (centred horizontally, 60 px gap from
         * the inner padding edge). Callouts are absolute-positioned at
         * fixed coords relative to the anatomy box. */}
        <div className="relative aspect-[5/3] overflow-hidden rounded-[14px] border border-line bg-paper p-10">
          <div className="mx-auto mt-[60px] w-[240px]">
            <MetricTile
              label="Distance"
              value={<span className="text-accent">1,284</span>}
              unit="km"
              unitPosition="after"
              delta="+18% vs March"
            />
          </div>
          <AnatomyCallout top={56} left={28}>
            → Stamp · uppercase mono
          </AnatomyCallout>
          <AnatomyCallout top={100} left={28}>
            → Hero number · 36 px sans 800
          </AnatomyCallout>
          <AnatomyCallout top={140} left={28}>
            → Unit · 11 px mono · fg-dim
          </AnatomyCallout>
          <AnatomyCallout top={184} left={28}>
            → Delta · 11 px · fg-mute
          </AnatomyCallout>
        </div>

        <Card padded>
          <SubStamp>Variants</SubStamp>
          <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.8] text-fg-dim">
            <li>
              <strong>Default</strong> — cream bg, ink type, dim delta
            </li>
            <li>
              <strong>Ink</strong> — ink bg, cream type. Used for the "north
              star" KPI of the screen
            </li>
            <li>
              <strong>Paper</strong> — paper bg. Used for derived/secondary KPIs
              (e.g. lean angle, peak)
            </li>
            <li>
              <strong>Accent number</strong> — orange tinted hero number.{" "}
              <em>One per row.</em>
            </li>
          </ul>
          <div className="mt-4">
            <CodeBlock>
              <CK>grid</CK>: <CN>repeat(4, 1fr)</CN>
              {"\n"}
              <CK>gap</CK>: <CN>14 px</CN>
              {"\n"}
              <CK>padding</CK>: <CN>18 px</CN>
              {"\n"}
              <CK>radius</CK>: <CN>14</CN>
            </CodeBlock>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/** Mono callout used inside the anatomy box. Mirrors source `.callout`:
 * `font-family: mono; font-size: 10px; font-weight: 700; letter-spacing: 1px;
 *  text-transform: uppercase; color: var(--fg-dim);` */
function AnatomyCallout({
  top,
  left,
  children,
}: {
  top: number;
  left: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="absolute font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-dim"
      style={{ top, left }}
    >
      {children}
    </div>
  );
}

/* -------- 13 · ROAD PREVIEW CARD -------- */

// Card 1's q-strip mostly-q5 with 2 q4 interruptions (source's exact
// sequence: q5, q5, q4, q5, q4, q5, q5, q5, q5, q4).
const SEG_ALL_GREEN = [5, 5, 4, 5, 4, 5, 5, 5, 5, 4].map((q) => ({
  q: q as 4 | 5,
}));
const SEG_MIXED_4 = [4, 4, 5, 3, 4, 4, 3, 4, 4, 4].map((q) => ({
  q: q as 3 | 4 | 5,
}));
const SEG_MIXED_2 = [3, 2, 2, 3, 2, 2, 1, 2, 3, 3].map((q) => ({
  q: q as 1 | 2 | 3,
}));

const ELEV_UP = [0.05, 0.18, 0.36, 0.55, 0.7, 0.84, 0.92];
const ELEV_DOWN = [0.95, 0.83, 0.65, 0.4, 0.23, 0.12, 0.05];
const ELEV_CLIMB = [0.1, 0.18, 0.3, 0.45, 0.6, 0.78, 0.88];

export function RoadPreviewSection() {
  const [active, setActive] = useState("2");

  return (
    <Section
      id="rpc"
      num="13 · Component · Road preview"
      title="The signature row."
      tone="tinted"
      intro={
        <>
          Stacked vertically in the trip planner's left rail. The active card
          inverts to ink fill (selected state). Elevation profile is filled and
          stroked with the segment's quality color; the strip of color
          rectangles under it shows quality per sub-segment.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <RoadPreviewCard
          index="01"
          name="Bormio → Passo Stelvio"
          quality={5}
          segments={SEG_ALL_GREEN}
          elevation={ELEV_UP}
          distanceKm={22}
          elevationGainM={1536}
          turns={48}
          active={active === "1"}
          onClick={() => setActive("1")}
        />
        <RoadPreviewCard
          index="02"
          name="Stelvio → Santa Maria"
          quality={4}
          segments={SEG_MIXED_4}
          elevation={ELEV_DOWN}
          distanceKm={18}
          elevationGainM={-980}
          turns={36}
          hazards={1}
          active={active === "2"}
          onClick={() => setActive("2")}
        />
        <RoadPreviewCard
          index="03"
          name="Umbrail Pass climb"
          quality={2}
          segments={SEG_MIXED_2}
          elevation={ELEV_CLIMB}
          distanceKm={13}
          elevationGainM={1200}
          turns={34}
          hazards={1}
          active={active === "3"}
          onClick={() => setActive("3")}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6">
        <Card padded>
          <SubStamp>Anatomy</SubStamp>
          <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.8] text-fg-dim">
            <li>
              <strong>Index chip</strong> — 22 × 22 paper rounded square, mono
              number
            </li>
            <li>
              <strong>Name</strong> — 14 px / 700 sans
            </li>
            <li>
              <strong>Q-bars</strong> — size 4, top-right
            </li>
            <li>
              <strong>Elevation</strong> — 52 px paper inner card, q-color SVG
              path
            </li>
            <li>
              <strong>Q-strip</strong> — 10 rectangles at the bottom of the
              elevation, palette-aware
            </li>
            <li>
              <strong>Meta row</strong> — mono · uppercase · 11 px · justified
              between
            </li>
            <li>
              <strong>Hazard count</strong> — appended in accent if &gt; 0
            </li>
          </ul>
        </Card>
        <Card padded>
          <SubStamp>States</SubStamp>
          <div className="overflow-hidden rounded-lg border border-line bg-cream">
            <SpecHead cols="100px 1fr 1fr">
              <span>State</span>
              <span>Background</span>
              <span>Border</span>
            </SpecHead>
            <SpecRow cols="100px 1fr 1fr">
              <span className="font-mono font-semibold">default</span>
              <span className="text-fg-dim">--cream</span>
              <span className="font-mono text-[11px] text-fg-dim">
                1 px --line
              </span>
            </SpecRow>
            <SpecRow cols="100px 1fr 1fr">
              <span className="font-mono font-semibold">hover</span>
              <span className="text-fg-dim">--cream</span>
              <span className="font-mono text-[11px] text-fg-dim">
                1 px --line-strong
              </span>
            </SpecRow>
            <SpecRow cols="100px 1fr 1fr" last>
              <span className="font-mono font-semibold">active</span>
              <span className="text-fg-dim">--ink · text cream</span>
              <span className="font-mono text-[11px] text-fg-dim">
                1 px ink
              </span>
            </SpecRow>
          </div>
          <div className="mt-4">
            <SubStamp>Density</SubStamp>
            <p className="text-[13px] leading-[1.55] text-fg-dim">
              Comfortable: 14 / 10 / 52. Compact: 12 / 8 / 36. Density tweak
              controls all three at once.
            </p>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* -------- 14 · NAV RAIL -------- */

export function NavRailSection() {
  return (
    <Section
      id="nav-rail"
      num="14 · Component · Nav rail"
      title="Ink rail, accent active."
      tone="dark"
      intro={
        <>
          220 px ink rail on the left of every web view. Brand mark → divider →
          numbered nav items → spacer → contribution module → user row. Active
          item is accent fill, ink text, 800 weight.
        </>
      }
    >
      <div className="grid grid-cols-[280px_1fr] items-start gap-7">
        {/* Source mock widens the rail to 280 px + rounds the corners
         * + adds a 1 px hairline so the rail floats as a documentation
         * card. Real product rails are 220 px wide and flush against
         * the page edge — that's `<NavRail />` defaults. */}
        <NavRail
          className="!w-[280px] rounded-[14px] border border-cream/10"
          brandTitle="TARMOTO"
          items={[
            { key: "trip", num: "01", label: "Trip Planner", active: true },
            { key: "explore", num: "02", label: "Road Explorer" },
            { key: "rides", num: "03", label: "Ride History" },
            { key: "community", num: "04", label: "Community" },
            { key: "account", num: "05", label: "Account" },
          ]}
          footer={
            <>
              <NavRailContribution
                value="4,284"
                unit="KM MAPPED"
                progress={0.68}
              />
              <div className="flex items-center gap-2.5 px-1.5 pb-1 pt-3">
                <div className="grid size-8 place-items-center rounded-full bg-accent text-[13px] font-extrabold text-ink">
                  L
                </div>
                <div>
                  <div className="text-[12px] font-bold text-cream">
                    Luca Berti
                  </div>
                  <Mono className="text-[9px] text-cream/50">
                    PRO · LOMBARDY
                  </Mono>
                </div>
              </div>
            </>
          }
        />

        <div>
          <SubStamp onDark>Spec</SubStamp>
          <div className="overflow-hidden rounded-[10px] border border-cream/12 bg-tarmac">
            <div
              className="grid items-center gap-3 border-b border-cream/8 bg-cream/6 px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1.2px] text-cream/60"
              style={{ gridTemplateColumns: "1fr 1fr 1fr" }}
            >
              <span>Slot</span>
              <span>Background</span>
              <span>Foreground</span>
            </div>
            {[
              ["rail", "--ink", "--cream"],
              [
                "item · inactive",
                "transparent",
                "cream · 600 · mono num @ 40%",
              ],
              ["item · active", "--accent", "ink · 800 · mono num ink"],
              ["item · hover", "cream @ 6%", "no other changes"],
              ["divider", "cream @ 8%", "1 px"],
              ["contrib module", "cream @ 6%", "border cream @ 8%"],
            ].map((row, i, arr) => (
              <div
                key={row[0]}
                className={`grid items-center gap-3 px-4 py-2.5 text-[12.5px] ${i < arr.length - 1 ? "border-b border-cream/8" : ""}`}
                style={{ gridTemplateColumns: "1fr 1fr 1fr" }}
              >
                <Mono className="font-semibold text-cream">{row[0]}</Mono>
                <span className="text-cream/70">{row[1]}</span>
                <span className="font-mono text-[11px] text-cream/55">
                  {row[2]}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <SubStamp onDark>Geometry</SubStamp>
            <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-on-dark-dim">
              <li>
                Rail width <Mono>220 px</Mono>
              </li>
              <li>
                Rail padding <Mono>20 / 14</Mono>
              </li>
              <li>
                Item padding <Mono>10 / 12</Mono>
              </li>
              <li>
                Item radius <Mono>8</Mono>
              </li>
              <li>
                Brand mark <Mono>32 sq · accent · 7 radius</Mono>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* -------- 15 · DATA TABLE -------- */

interface Ride {
  date: string;
  ride: string;
  km: number;
  duration: string;
  avg: number;
  lean: string;
  q: 1 | 2 | 3 | 4 | 5;
}

// Source shows 3 sample rows ("18 Apr Stelvio Loop / 13 Apr Passo Gavia /
// 05 Apr Mortirolo test") with a header saying "12 rides · click to
// inspect" — the table is documented as a preview of a longer
// scrollable list rather than the literal full set.
const RIDES: Ride[] = [
  {
    date: "18 Apr",
    ride: "Stelvio Loop",
    km: 186,
    duration: "4h 12m",
    avg: 64,
    lean: "38°",
    q: 4,
  },
  {
    date: "13 Apr",
    ride: "Passo Gavia",
    km: 142,
    duration: "3h 28m",
    avg: 58,
    lean: "34°",
    q: 5,
  },
  {
    date: "05 Apr",
    ride: "Mortirolo test",
    km: 74,
    duration: "2h 02m",
    avg: 46,
    lean: "40°",
    q: 2,
  },
];
const RIDES_TOTAL = 12;

export function TableSection() {
  return (
    <Section
      id="table"
      num="15 · Component · Data table"
      title="Ride history pattern."
      intro={
        <>
          Fixed grid columns, mono numeric cells, a single QualityBars column.
          Header row is paper-tinted with uppercase mono labels; body rows are
          cream with hairline dividers. Click anywhere on a row to inspect.
        </>
      }
    >
      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <Stamp>Recent rides</Stamp>
            <div className="mt-1 text-[15px] font-bold">
              {RIDES_TOTAL} rides · click to inspect
            </div>
          </div>
          <div className="flex gap-1.5">
            <Pill variant="ghost">Export CSV</Pill>
            <Pill variant="ghost">Compare rides</Pill>
          </div>
        </div>

        <DataTable<Ride>
          rowKey={(r) => `${r.date}-${r.ride}`}
          onRowClick={() => {}}
          columns={[
            {
              key: "date",
              label: "Date",
              size: "80px",
              numeric: true,
              render: (r) => <span className="text-fg-dim">{r.date}</span>,
            },
            {
              key: "ride",
              label: "Ride",
              size: "1fr",
              render: (r) => <span className="font-bold">{r.ride}</span>,
            },
            {
              key: "km",
              label: "KM",
              size: "80px",
              numeric: true,
              render: (r) => <span className="font-bold">{r.km}</span>,
            },
            {
              key: "duration",
              label: "Duration",
              size: "90px",
              numeric: true,
              render: (r) => <span className="text-fg-dim">{r.duration}</span>,
            },
            {
              key: "avg",
              label: "Avg",
              size: "70px",
              numeric: true,
              render: (r) => <span>{r.avg}</span>,
            },
            {
              key: "lean",
              label: "Lean",
              size: "70px",
              numeric: true,
              render: (r) => <span>{r.lean}</span>,
            },
            {
              key: "q",
              label: "Quality",
              size: "90px",
              render: (r) => <QualityBars q={r.q} size={4} />,
            },
          ]}
          rows={RIDES}
        />
      </Card>

      <div className="mt-6 grid grid-cols-3 gap-3.5">
        <Card padded>
          <SubStamp>Column rule</SubStamp>
          <p className="text-[13px] leading-[1.55] text-fg-dim">
            Numeric columns are always mono. Identity columns (date, ride name)
            use the working font. Quality is always last column before the
            chevron.
          </p>
        </Card>
        <Card padded>
          <SubStamp>Header rule</SubStamp>
          <p className="text-[13px] leading-[1.55] text-fg-dim">
            Header row is paper-tinted, 10 px mono, 1 px letter-spacing,
            uppercase, fg-mute. Always sticky if the table can scroll
            vertically.
          </p>
        </Card>
        <Card padded>
          <SubStamp>Row rule</SubStamp>
          <p className="text-[13px] leading-[1.55] text-fg-dim">
            14 / 20 padding · 13 px text · 1 px line divider · chevron in{" "}
            <Mono className="text-ink">--fg-mute</Mono>. No row hover background
            — just cursor pointer.
          </p>
        </Card>
      </div>
    </Section>
  );
}

/* -------- 16 · TWEAKS PANEL -------- */

export function TweaksSection() {
  const [tokens, setTokens] = useState<TweaksTokens>(DEFAULT_TWEAKS);

  return (
    <Section
      id="tweaks"
      num="16 · Component · Tweaks panel"
      title="Bottom-right, 300 px."
      tone="tinted"
      intro={
        <>
          Persistent settings panel exposed via the toolbar's "Tweaks" toggle.
          Floating card, cream fill, lift shadow, 300 px wide. Four control
          rows: mapMode, palette, density, accent.
        </>
      }
    >
      <div className="grid grid-cols-[320px_1fr] items-start gap-7">
        <TweaksPanel value={tokens} onChange={setTokens} onClose={() => {}} />
        <div>
          <SubStamp>Token shape (persisted)</SubStamp>
          <CodeBlock>
            {`{\n  `}
            <CK>{`"accent"`}</CK>
            {`: `}
            <CS>{`"${tokens.accent}"`}</CS>
            {`,\n  `}
            <CK>{`"palette"`}</CK>
            {`: `}
            <CS>{`"${tokens.palette}"`}</CS>
            {`,   `}
            <CC>{`// traffic | muted | mono`}</CC>
            {`\n  `}
            <CK>{`"mapMode"`}</CK>
            {`: `}
            <CS>{`"${tokens.mapMode}"`}</CS>
            {`,     `}
            <CC>{`// paper | light | dark`}</CC>
            {`\n  `}
            <CK>{`"density"`}</CK>
            {`: `}
            <CS>{`"${tokens.density}"`}</CS>
            {` `}
            <CC>{`// comfortable | compact`}</CC>
            {`\n}`}
          </CodeBlock>
          <p className="mt-3.5 text-[13px] leading-[1.55] text-fg-dim">
            Wraps in <Mono>EDITMODE-BEGIN</Mono> / <Mono>EDITMODE-END</Mono>{" "}
            markers — the host rewrites this JSON when the user changes a value.
            Every view that responds to tweaks consumes the same{" "}
            <Mono>tokens</Mono> prop.
          </p>
        </div>
      </div>
    </Section>
  );
}
