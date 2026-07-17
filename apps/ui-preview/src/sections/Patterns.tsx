import { Section, SubStamp } from "../Section";
import {
  Button,
  Card,
  ErrorState,
  LayoutShell,
  Mono,
  PageHeader,
  PageLoadingBar,
  QualityBars,
  RoadPreviewCard,
  SkeletonDashboard,
  SkeletonForm,
  SkeletonGrid,
  SkeletonList,
  SkeletonPageHeader,
  Stamp,
} from "@tarmoto/ui";
import { CK, CN, CodeBlock, TokenTable } from "./_shared";

/* ============================================================
 * 24 · LAYOUTS (source §20)
 * ============================================================ */

export function LayoutsSection() {
  return (
    <Section
      id="layouts"
      num="24 · Layouts"
      title="Four shells."
      tone="tinted"
      intro={
        <>
          Every Web App v2 view fits into one of these. Use the matching shell —
          don't invent a fifth.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-5">
        <div>
          <LayoutShell kind="three-col" />
          <div className="pt-3">
            <Stamp>Three-column · Trip Planner</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              360 px list (cream) · fluid map (paper) · 340 px params (paper).
            </p>
          </div>
        </div>
        <div>
          <LayoutShell kind="two-col" />
          <div className="pt-3">
            <Stamp>Two-column · Road Explorer</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              Fluid map (paper) · 380 px detail panel (paper).
            </p>
          </div>
        </div>
        <div>
          <LayoutShell kind="single-col" />
          <div className="pt-3">
            <Stamp>Single column · History &amp; Community</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              24 / 28 px page padding · header + 4-up metrics + content rows.
            </p>
          </div>
        </div>
        <div>
          <LayoutShell kind="sidebar" />
          <div className="pt-3">
            <Stamp>Sidebar · Account</Stamp>
            <p className="mt-1.5 text-[13px] leading-[1.55] text-fg-dim">
              220 px section nav (cream, ink active) · settings cards stacked.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-7">
        <SubStamp>Surface contract</SubStamp>
        <TokenTable
          columns={[
            { label: "Slot", size: "160px" },
            { label: "Background", size: "1fr" },
            { label: "Right border", size: "1fr" },
            { label: "Default content", size: "1fr" },
          ]}
          rows={[
            [
              <Mono className="font-semibold">rail (220)</Mono>,
              <span className="text-fg-dim">--ink</span>,
              <Mono className="text-fg-mute">1 px --line</Mono>,
              <Mono className="text-fg-mute">
                brand · nav · contrib · user
              </Mono>,
            ],
            [
              <Mono className="font-semibold">list (360)</Mono>,
              <span className="text-fg-dim">--cream</span>,
              <Mono className="text-fg-mute">1 px --line</Mono>,
              <Mono className="text-fg-mute">
                header · filters · scroll cards
              </Mono>,
            ],
            [
              <Mono className="font-semibold">canvas (fluid)</Mono>,
              <span className="text-fg-dim">paper (map) / cream (page)</span>,
              <Mono className="text-fg-mute">—</Mono>,
              <Mono className="text-fg-mute">map · cards · chart</Mono>,
            ],
            [
              <Mono className="font-semibold">params (340/380)</Mono>,
              <span className="text-fg-dim">--paper</span>,
              <Mono className="text-fg-mute">1 px --line · left</Mono>,
              <Mono className="text-fg-mute">stamp + control groups</Mono>,
            ],
          ]}
        />
      </div>
    </Section>
  );
}

/* ============================================================
 * 25 · DENSITY (source §21)
 * ============================================================ */

const SEG_ALL_GREEN = Array.from({ length: 10 }, () => ({ q: 5 as const }));

const ELEV_UP = [0.05, 0.18, 0.36, 0.55, 0.7, 0.84, 0.92];

export function DensitySection() {
  return (
    <Section
      id="density"
      num="25 · Density"
      title="Comfortable vs compact."
      intro={
        <>
          The density tweak swaps three values across the app. Most surfaces
          honor it. Marketing surfaces, headers, and the brand mark do{" "}
          <em>not</em>.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-5">
        <Card padded className="!p-6">
          <Stamp>Comfortable</Stamp>
          <div className="mt-3">
            <RoadPreviewCard
              index="01"
              name="Bormio → Passo Stelvio"
              quality={5}
              segments={SEG_ALL_GREEN}
              elevation={ELEV_UP}
              distanceKm={22}
              elevationGainM={1536}
              turns={48}
            />
          </div>
          <div className="mt-3.5">
            <CodeBlock>
              <CK>card-pad</CK>: <CN>14</CN> · <CK>gap</CK>: <CN>10</CN>
              {"\n"}
              <CK>elev-h</CK>: <CN>52</CN> · <CK>name</CK>: <CN>14 px</CN>
            </CodeBlock>
          </div>
        </Card>

        <Card padded className="!p-6">
          <Stamp>Compact</Stamp>
          <div className="mt-3">
            <CompactRpc />
          </div>
          <div className="mt-3.5">
            <CodeBlock>
              <CK>card-pad</CK>: <CN>12</CN> · <CK>gap</CK>: <CN>8</CN>
              {"\n"}
              <CK>elev-h</CK>: <CN>36</CN> · <CK>name</CK>: <CN>13 px</CN>
            </CodeBlock>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/**
 * Compact RoadPreviewCard preview — the library's RoadPreviewCard always
 * renders the comfortable density (14 / 10 / 52). We reconstruct a
 * compact variant inline because the variant isn't (yet) a prop on the
 * component itself.
 *
 * NOTE: when density becomes a real prop on `RoadPreviewCard`, replace
 * this with `<RoadPreviewCard density="compact" … />`.
 */
function CompactRpc() {
  return (
    <div className="flex w-full flex-col gap-2 rounded-[14px] border border-line bg-cream p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-[22px] place-items-center rounded-md bg-paper font-mono text-[11px] font-bold">
            01
          </div>
          <div className="truncate text-[13px] font-bold">
            Bormio → Passo Stelvio
          </div>
        </div>
        <QualityBars q={5} size={4} />
      </div>
      <div className="relative h-9 overflow-hidden rounded-lg bg-paper">
        <svg
          viewBox="0 0 200 60"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          <path
            d="M 0 50 L 40 42 80 28 120 14 160 8 200 4 L 200 60 L 0 60 Z"
            fill="#6FD38A"
            fillOpacity={0.35}
            stroke="#6FD38A"
            strokeWidth={1.2}
          />
          {Array.from({ length: 10 }).map((_, i) => (
            <rect
              key={i}
              x={i * 20}
              y={54}
              width={20}
              height={6}
              fill="#6FD38A"
            />
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-fg-dim">
        <span>22 KM</span>
        <span>↗ 1536M</span>
        <span>48 TURNS</span>
      </div>
    </div>
  );
}

/* ============================================================
 * 26 · DO & DON'T (source §22)
 * ============================================================ */

export function DoDontSection() {
  return (
    <Section
      id="do-dont"
      num="26 · Do & don't"
      title="The short list."
      tone="tinted"
      intro={
        <>
          The rules that, if respected, get you 90 % of the way to a
          Tarmoto-feeling screen. Everything else is a refinement on top.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        <div>
          <BigRule
            kind="do"
            title="Lead every section with a stamp + heading pair."
            body="Mono uppercase eyebrow + 22–32 px sans heading + optional 12 px sub. This is the heartbeat of the layout."
          />
          <BigRule
            kind="do"
            title="Reach for mono whenever you have a number."
            body="Km, °, hours, percentages, dates — all mono. Body text stays in Space Grotesk."
          />
          <BigRule
            kind="do"
            title="Border first, shadow rarely."
            body={
              <>
                A 1 px <Mono className="text-ink">--line</Mono> separates flush
                surfaces. Shadows are only for floaters above the map and the
                Tweaks panel.
              </>
            }
          />
          <BigRule
            kind="do"
            title={`Use Q-bars wherever you'd otherwise type "5/5".`}
            body="Stars don't exist in Tarmoto. The bar glyph is the only quality indicator."
          />
          <BigRule
            kind="do"
            title="Invert one card per view to ink."
            body="Either the hero KPI, the active day card, the call-out, or the active challenge. Pick one — never two."
          />
        </div>
        <div>
          <BigRule
            kind="dont"
            title="Don't tint surfaces orange."
            body="Accent never paints a card background. Backgrounds are cream, paper, paper-2, or ink. Full stop."
          />
          <BigRule
            kind="dont"
            title="Don't reintroduce stars, hearts (as data), or thumbs-up."
            body="Heart is allowed on community routes for likes only. Stars, thumbs, ratings out of 10 — replace with Q-bars."
          />
          <BigRule
            kind="dont"
            title="Don't introduce new colors mid-screen."
            body={
              <>
                If you need a hue, it comes from{" "}
                <Mono className="text-ink">--accent</Mono>, the quality scale,
                or one of the three collab colors. Nothing else.
              </>
            }
          />
          <BigRule
            kind="dont"
            title="Don't nest cards more than two deep."
            body="Card on cream + nested cell on paper-2 is the limit. Three layers means the layout is broken."
          />
          <BigRule
            kind="dont"
            title="Don't change the nav rail."
            body="Ink, 220 px, brand at top, accent active, contribution + user at bottom. Same on every web view."
          />
        </div>
      </div>
    </Section>
  );
}

function BigRule({
  kind,
  title,
  body,
}: {
  kind: "do" | "dont";
  title: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-start gap-[18px] border-b border-line py-[18px] last:border-b-0">
      <div
        className={`rounded px-2 py-1 text-center font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${
          kind === "do" ? "bg-quality-q5 text-ink" : "bg-quality-q1 text-cream"
        }`}
      >
        {kind === "do" ? "Do" : "Don't"}
      </div>
      <div>
        <div className="mb-1 text-[14px] font-bold">{title}</div>
        <div className="text-[13px] leading-[1.55] text-fg-dim">{body}</div>
      </div>
    </div>
  );
}

/* -------- 27 · SYSTEM STATES -------- */

export function SystemStatesSection() {
  return (
    <Section
      id="system-states"
      num="27 · System states"
      title="One layout for every dead end — 404, 403, 500, offline, maintenance."
      intro={
        <>
          A faded topographic map under a centred icon tile, mono{" "}
          <CN>CODE • LABEL</CN> stamp, headline, and recovery actions. The{" "}
          <CN>kind</CN> picks the glyph; copy and buttons come from the caller
          so every surface stays i18n-able.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        <Card padded={false} className="overflow-hidden !p-0">
          <div className="h-[440px]">
            <ErrorState
              className="h-full"
              kind="not-found"
              code="404"
              label="Not found"
              title="This road isn't on the map"
              body="The route or page you're after has moved, ended, or never existed. Let's get you back on tarmac."
              actions={
                <>
                  <Button variant="accent" uppercase>
                    Back to home
                  </Button>
                  <Button variant="secondary" uppercase>
                    Open Road Explorer
                  </Button>
                </>
              }
            />
          </div>
        </Card>

        <Card padded={false} className="overflow-hidden !p-0">
          <div className="h-[440px]">
            <ErrorState
              className="h-full"
              kind="offline"
              code="OFF"
              label="No connection"
              title="You're offline"
              body="We can't reach Tarmoto right now. Cached trips and maps still work; changes sync automatically when you reconnect."
              actions={
                <Button variant="accent" uppercase>
                  Retry connection
                </Button>
              }
              footnote="Last synced 2 min ago · 3 changes queued"
            />
          </div>
        </Card>

        <div className="grid grid-cols-3 gap-6">
          {(
            [
              ["forbidden", "403", "Access denied", "This ride is private"],
              ["server", "500", "Server error", "Something skidded out"],
              ["maintenance", "503", "Maintenance", "Resurfacing in progress"],
            ] as const
          ).map(([kind, code, label, title]) => (
            <Card key={kind} padded={false} className="overflow-hidden !p-0">
              <div className="h-[320px]">
                <ErrorState
                  className="h-full"
                  kind={kind}
                  code={code}
                  label={label}
                  title={title}
                  body="Variant preview — copy comes from the app."
                />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* -------- 28 · LOADING -------- */

export function LoadingSection() {
  return (
    <Section
      id="loading"
      num="28 · Loading"
      title="Shimmer skeletons + the accent progress bar."
      tone="tinted"
      intro={
        <>
          Content loaders mirror the layout they replace — list rows, card grid,
          dashboard — under a 3px indeterminate accent bar. Always gate them
          behind <CN>useDelayedLoading</CN> so warm responses never flash.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        <Card padded className="relative overflow-hidden !p-6">
          <PageLoadingBar />
          <SubStamp>List · rides &amp; trips</SubStamp>
          <div className="mt-3">
            <SkeletonPageHeader />
            <SkeletonList rows={2} />
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-6">
          <Card padded className="!p-6">
            <SubStamp>Grid · community</SubStamp>
            <div className="mt-3">
              <SkeletonGrid cards={4} className="!grid-cols-2" />
            </div>
          </Card>
          <Card padded className="!p-6">
            <SubStamp>Dashboard · stats</SubStamp>
            <div className="mt-3">
              <SkeletonDashboard />
            </div>
          </Card>
        </div>

        <Card padded className="!p-6">
          <SubStamp>Form · settings</SubStamp>
          <div className="mt-3">
            <SkeletonForm sections={2} />
          </div>
        </Card>

        <div>
          <CodeBlock>
            {`shimmer: `}
            <CN>animate-skeleton</CN>
            {` · ink 5.5→11% sweep · 1.5s linear\n`}
            {`bar: `}
            <CN>PageLoadingBar</CN>
            {` · 30% accent segment · 1.1s ease-in-out\n`}
            {`a11y: blocks aria-hidden · sr-only role=status label · motion-reduce safe`}
          </CodeBlock>
        </div>
      </div>
    </Section>
  );
}

/* -------- 29 · STICKY HEADER -------- */

export function StickyHeaderSection() {
  return (
    <Section
      id="sticky-header"
      num="29 · Sticky header"
      title="Large title condenses on scroll."
      tone="tinted"
      intro={
        <>
          <CN>PageHeader</CN> watches itself with an IntersectionObserver: once
          the large title scrolls out of view, a slim full-width bar — icon,
          title, and the <CN>right</CN> actions — pins to the top of the scroll
          container, which must be a Tailwind <CN>@container</CN>. On by
          default; opt out with <CN>sticky=&#123;false&#125;</CN>.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6">
        <Card padded className="!p-0">
          <div className="h-[300px] overflow-y-auto p-6">
            <PageHeader
              stamp="Ride history"
              title="Ride History"
              sub="Scroll this panel — the header condenses into a floating bar."
              right={
                <Button variant="accent" size="sm" uppercase>
                  Record ride
                </Button>
              }
            />
            {Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                className="mb-3 h-16 rounded-[14px] border border-line bg-paper-2"
              />
            ))}
          </div>
        </Card>

        <div>
          <CodeBlock>
            {`trigger: IntersectionObserver · threshold 0 · condenses only once fully out of view
`}
            {`bar: sticky zero-height slot · 100cqw full-bleed + border-b · paper/90 blur · `}
            <CN>animate-header-in</CN>
            {`
`}
            {`a11y: bar mounts only while condensed · single h1 · original actions go inert · motion-reduce safe`}
          </CodeBlock>
        </div>
      </div>
    </Section>
  );
}
