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
        </Card>
        <Card variant="ink">
          <Stamp tone="accent">Inverse · hero</Stamp>
          <div className="mt-1.5 text-[17px] font-bold">Active challenge</div>
          <Mono className="mt-1 block text-[11px] text-cream/60">
            Once per view
          </Mono>
          <div className="mt-3.5 h-[60px] rounded-lg bg-cream/6" />
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
      <div className="grid grid-cols-4 gap-3.5">
        <MetricTile
          variant="ink"
          accentNumber
          label="Distance"
          value="1,284"
          unit="km"
          delta="+18% vs March"
        />
        <MetricTile
          label="Ride time"
          value="32"
          unit="hrs"
          delta="+4h vs March"
        />
        <MetricTile
          label="New roads"
          value="47"
          unit="discovered"
          delta="+12 this month"
        />
        <MetricTile
          variant="paper"
          accentNumber
          label="Lean angle"
          value="41°"
          unit="max"
          delta="Passo Gavia"
        />
      </div>
    </Section>
  );
}

/* -------- 13 · ROAD PREVIEW CARD -------- */

const SEG_ALL_GREEN = Array.from({ length: 10 }, () => ({ q: 5 as const }));
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
          stroked with the segment's quality color; the strip of colour
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
              <strong>Elevation</strong> — 52 px paper inner card, q-colour SVG
              path
            </li>
            <li>
              <strong>Q-strip</strong> — palette-aware rectangles at the bottom
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
              <span>Foreground</span>
            </SpecHead>
            <SpecRow cols="100px 1fr 1fr">
              <span className="font-mono font-semibold">default</span>
              <span className="text-fg-dim">--cream</span>
              <span className="font-mono text-[11px] text-fg-dim">
                --ink + --fg-dim meta
              </span>
            </SpecRow>
            <SpecRow cols="100px 1fr 1fr" last>
              <span className="font-mono font-semibold">active</span>
              <span className="text-fg-dim">--ink</span>
              <span className="font-mono text-[11px] text-fg-dim">
                --cream + onDark qbars
              </span>
            </SpecRow>
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
        <NavRail
          brandTitle="TARMOTO"
          brandSub="WEB · v1.4"
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
            <li>Active item: accent fill, ink fg, 800 weight</li>
          </ul>
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
              {RIDES.length} rides · click to inspect
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
        <Card padded>
          <SubStamp>Token shape (persisted)</SubStamp>
          <pre className="m-0 overflow-x-auto rounded-[10px] bg-ink p-4 font-mono text-[11px] leading-[1.65] text-cream">
            {`{
  "accent": "${tokens.accent}",
  "palette": "${tokens.palette}",   // traffic | muted | mono
  "mapMode": "${tokens.mapMode}",     // paper | light | dark
  "density": "${tokens.density}" // comfortable | compact
}`}
          </pre>
          <p className="mt-3.5 text-[13px] leading-[1.55] text-fg-dim">
            The panel is fully controlled — the host owns the tokens state and
            persists it (localStorage, user prefs, …). Every screen consumes the
            same shape.
          </p>
        </Card>
      </div>
    </Section>
  );
}
