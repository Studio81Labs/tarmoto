import { Section, SubStamp } from "../Section";
import {
  Alert,
  Button,
  Card,
  Mono,
  Toast,
  Tooltip,
  palette,
  qualityColors,
} from "@tarmoto/ui";
import { SpecHead, SpecRow } from "./Atoms";
import { CodeBlock, ColorDot, CN, DoDontGrid, TokenTable } from "./_shared";

/* -------- 17 · BUTTONS -------- */

export function ButtonsSection() {
  return (
    <Section
      id="buttons"
      num="17 · Component · Buttons & CTAs"
      title={
        <>
          Three sizes,
          <br />
          three weights.
        </>
      }
      tone="tinted"
      intro={
        <>
          Pills (section 08) carry compact actions inside chrome. Buttons carry
          the commit — "Push to phone", "Re-generate itinerary", "Add bike".
          Three sizes (sm 32 · md 40 · lg 48), three weights (primary ·
          secondary · ghost), plus a single destructive style. Full-width is the
          default in panels; auto-width inline.
        </>
      }
    >
      <Card padded className="!p-7">
        <div className="grid grid-cols-[110px_repeat(3,1fr)] items-center gap-x-[18px] gap-y-4">
          <div />
          <SubStamp>Primary</SubStamp>
          <SubStamp>Secondary</SubStamp>
          <SubStamp>Ghost</SubStamp>

          {(["lg", "md", "sm"] as const).map((size) => (
            <SizedRow key={size} size={size} />
          ))}
        </div>

        <div className="my-7 h-px bg-line" />

        <div className="grid grid-cols-[110px_repeat(3,1fr)] items-center gap-x-[18px] gap-y-4">
          <Mono className="text-right text-[11px] text-fg-dim">ACCENT</Mono>
          <Button variant="accent" block>
            Re-generate ↺
          </Button>
          <div />
          <div />

          <Mono className="text-right text-[11px] text-fg-dim">
            DESTRUCTIVE
          </Mono>
          <Button variant="danger" block>
            Delete account
          </Button>
          <div />
          <div />

          <Mono className="text-right text-[11px] text-fg-dim">ON-DARK</Mono>
          <div className="col-span-3 flex gap-3 rounded-[10px] bg-ink p-3.5">
            <Button variant="accent" className="flex-1">
              Manage billing
            </Button>
            <Button variant="on-dark" className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      </Card>

      <div className="mt-7">
        <SubStamp>States · primary md</SubStamp>
        <Card padded className="!p-7">
          <div className="grid grid-cols-5 gap-4">
            <StateCol label="REST">
              <Button block>Default</Button>
            </StateCol>
            {/* Hover state — source `.btn.btn-primary.hover` swaps the ink
             * background for tarmac to simulate the hover-darkened state
             * without actual pointer interaction. */}
            <StateCol label="+ TARMAC TINT">
              <Button block className="!bg-tarmac">
                Hover
              </Button>
            </StateCol>
            {/* Focus state — 2 px accent ring around the resting button. */}
            <StateCol label="2 PX ACCENT RING">
              <Button
                block
                className="ring-2 ring-accent ring-offset-2 ring-offset-cream"
              >
                Focus
              </Button>
            </StateCol>
            <StateCol label="40% OPACITY">
              <Button block disabled>
                Disabled
              </Button>
            </StateCol>
            <StateCol label="+ SPINNER">
              <Button block loading>
                Loading
              </Button>
            </StateCol>
          </div>
        </Card>
      </div>

      <div className="mt-7">
        <SubStamp>Geometry & tokens</SubStamp>
        <Card padded={false} className="overflow-hidden">
          <SpecHead cols="120px 100px 100px 1fr 1fr">
            <span>Variant</span>
            <span>Background</span>
            <span>Text</span>
            <span>Border</span>
            <span>Use</span>
          </SpecHead>
          <SpecRow cols="120px 100px 100px 1fr 1fr">
            <span className="font-mono font-semibold">primary</span>
            <span className="text-fg-dim">--ink</span>
            <span className="text-fg-dim">--cream</span>
            <span className="font-mono text-[11px] text-fg-dim">none</span>
            <span className="font-mono text-[11px] text-fg-dim">
              Commit on cream
            </span>
          </SpecRow>
          <SpecRow cols="120px 100px 100px 1fr 1fr">
            <span className="font-mono font-semibold">accent</span>
            <span className="text-fg-dim">--accent</span>
            <span className="text-fg-dim">--ink</span>
            <span className="font-mono text-[11px] text-fg-dim">none</span>
            <span className="font-mono text-[11px] text-fg-dim">
              Commit on ink, regen
            </span>
          </SpecRow>
          <SpecRow cols="120px 100px 100px 1fr 1fr">
            <span className="font-mono font-semibold">secondary</span>
            <span className="text-fg-dim">transparent</span>
            <span className="text-fg-dim">--ink</span>
            <span className="font-mono text-[11px] text-fg-dim">
              1 px line-strong
            </span>
            <span className="font-mono text-[11px] text-fg-dim">
              Companion to primary
            </span>
          </SpecRow>
          <SpecRow cols="120px 100px 100px 1fr 1fr">
            <span className="font-mono font-semibold">ghost</span>
            <span className="text-fg-dim">transparent</span>
            <span className="text-fg-dim">--fg-dim</span>
            <span className="font-mono text-[11px] text-fg-dim">none</span>
            <span className="font-mono text-[11px] text-fg-dim">
              Tertiary, in-flow
            </span>
          </SpecRow>
          <SpecRow cols="120px 100px 100px 1fr 1fr">
            <span className="font-mono font-semibold">danger</span>
            <span className="text-fg-dim">transparent</span>
            <span className="text-fg-dim">--q1</span>
            <span className="font-mono text-[11px] text-fg-dim">1 px Q1</span>
            <span className="font-mono text-[11px] text-fg-dim">
              Destructive only
            </span>
          </SpecRow>
          <SpecRow cols="120px 100px 100px 1fr 1fr" last>
            <span className="font-mono font-semibold">on-dark</span>
            <span className="text-fg-dim">cream @ 10%</span>
            <span className="text-fg-dim">--cream</span>
            <span className="font-mono text-[11px] text-fg-dim">
              1 px cream @ 15%
            </span>
            <span className="font-mono text-[11px] text-fg-dim">
              Secondary inside ink card
            </span>
          </SpecRow>
        </Card>

        <Card padded={false} className="mt-0 overflow-hidden border-t-0">
          <SpecHead cols="120px 1fr 1fr 1fr 1fr">
            <span>Size</span>
            <span>Height</span>
            <span>Padding x</span>
            <span>Font</span>
            <span>Radius</span>
          </SpecHead>
          <SpecRow cols="120px 1fr 1fr 1fr 1fr">
            <span className="font-mono font-semibold">sm</span>
            <span className="text-fg-dim">32 px</span>
            <span className="text-fg-dim">14 px</span>
            <span className="font-mono text-[11px] text-fg-dim">12 / 700</span>
            <span className="font-mono text-[11px] text-fg-dim">8</span>
          </SpecRow>
          <SpecRow cols="120px 1fr 1fr 1fr 1fr">
            <span className="font-mono font-semibold">md · default</span>
            <span className="text-fg-dim">40 px</span>
            <span className="text-fg-dim">18 px</span>
            <span className="font-mono text-[11px] text-fg-dim">13 / 700</span>
            <span className="font-mono text-[11px] text-fg-dim">10</span>
          </SpecRow>
          <SpecRow cols="120px 1fr 1fr 1fr 1fr" last>
            <span className="font-mono font-semibold">lg</span>
            <span className="text-fg-dim">48 px</span>
            <span className="text-fg-dim">22 px</span>
            <span className="font-mono text-[11px] text-fg-dim">14 / 700</span>
            <span className="font-mono text-[11px] text-fg-dim">12</span>
          </SpecRow>
        </Card>
      </div>

      <DoDontGrid
        className="mt-7"
        left={[
          {
            kind: "do",
            title: "One primary action per surface.",
            body: "A card, panel, or dialog gets exactly one ink (or accent) button. Companions are secondary or ghost.",
          },
          {
            kind: "do",
            title: "Match button color to the surface it's on.",
            body: "Ink button on cream. Accent button on ink. Never accent on cream as a primary.",
          },
        ]}
        right={[
          {
            kind: "dont",
            title: "Don't use a button where a pill fits.",
            body: "Filter chips, toolbar items, status indicators — those stay pills. Buttons are for verbs that change state.",
          },
          {
            kind: "dont",
            title: "Don't mix sizes in a row.",
            body: "A row of buttons is one size end to end. If one needs to be bigger, the others were the wrong size.",
          },
        ]}
      />
    </Section>
  );
}

function SizedRow({ size }: { size: "sm" | "md" | "lg" }) {
  const label = { sm: "SM · 32", md: "MD · 40", lg: "LG · 48" }[size];
  const labels = {
    sm: ["Save", "Manage", "Cancel"],
    md: ["Add to trip", "Share embed", "Edit"],
    lg: ["Push to phone", "Cancel changes", "Skip step"],
  };
  return (
    <>
      <Mono className="text-right text-[11px] text-fg-dim">{label}</Mono>
      <Button variant="primary" size={size} block>
        {labels[size][0]}
      </Button>
      <Button variant="secondary" size={size} block>
        {labels[size][1]}
      </Button>
      <Button variant="ghost" size={size} block>
        {labels[size][2]}
      </Button>
    </>
  );
}

function StateCol({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-2 text-center">
      {children}
      <Mono className="text-[10px] tracking-[1px] text-fg-dim">{label}</Mono>
    </div>
  );
}

/* -------- 18 · ALERTS -------- */

export function AlertsSection() {
  return (
    <Section
      id="alerts"
      num="18 · Component · Alerts & banners"
      title={
        <>
          Inline, persistent,
          <br />
          contextual.
        </>
      }
      intro={
        <>
          For information that lives <em>inside</em> the layout — failed sync,
          outdated data, GDPR confirmations, info call-outs in settings. Banners
          take a full column; inline alerts sit inside a card. Five intents
          share one anatomy: stripe + glyph + title + body + optional action.
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Alert
          intent="info"
          title="New road quality data available"
          action={
            <Button variant="secondary" size="sm">
              Review changes
            </Button>
          }
        >
          12 segments in your saved Alps Loop were updated this morning.
        </Alert>

        <Alert intent="success" title="Itinerary pushed to phone">
          All 4 days are now on Luca's iPhone 16 Pro. Offline maps cached.
        </Alert>

        <Alert
          intent="warning"
          title="Stelvio Pass closes for winter on Oct 31"
          action={
            <Button variant="secondary" size="sm">
              Reroute
            </Button>
          }
        >
          Day 1 of your itinerary crosses this pass. Reroute or move the trip 2
          weeks earlier.
        </Alert>

        <Alert
          intent="danger"
          title="3 hazards on your saved route"
          action={
            <Button variant="danger" size="sm">
              View hazards
            </Button>
          }
        >
          All confirmed by riders in the last 48 hours. Tap to view on map.
        </Alert>

        <Alert
          intent="neutral"
          title="Your data contribution is anonymized"
          action={
            <Button variant="ghost" size="sm">
              How it works
            </Button>
          }
        >
          Accelerometer readings are hashed and unlinked from your account
          before upload.
        </Alert>
      </div>

      <div className="mt-7">
        <SubStamp>Inline alert · compact</SubStamp>
        <Card padded className="!p-[22px]">
          <div className="font-bold">Stelvio Loop · Day 3</div>
          <div className="mt-1 text-[13px] text-fg-dim">
            Forcola → Tirano · 164 km · 3 hazards
          </div>
          <div className="mt-3">
            <Alert intent="warning" compact title="Pass closes Oct 31.">
              Trip starts Nov 3.
            </Alert>
          </div>
        </Card>
      </div>

      <div className="mt-7">
        <SubStamp>Intent → tokens</SubStamp>
        <TokenTable
          columns={[
            { label: "Intent", size: "120px" },
            { label: "Stripe" },
            { label: "Glyph" },
            { label: "Background" },
            { label: "Title color" },
          ]}
          rows={[
            [
              <Mono key="0">info</Mono>,
              <span key="1" className="inline-flex items-center gap-2">
                <ColorDot color={palette.ink} size={18} shape="square" />
                <Mono>--ink</Mono>
              </span>,
              <Mono key="2">--ink</Mono>,
              <Mono key="3">--paper</Mono>,
              <Mono key="4">--ink</Mono>,
            ],
            [
              <Mono key="0">success</Mono>,
              <span key="1" className="inline-flex items-center gap-2">
                <ColorDot color={qualityColors[4]} size={18} shape="square" />
                <Mono>--q5</Mono>
              </span>,
              <Mono key="2">--q5</Mono>,
              <Mono key="3">Q5 @ 12%</Mono>,
              <Mono key="4">--ink</Mono>,
            ],
            [
              <Mono key="0">warning</Mono>,
              <span key="1" className="inline-flex items-center gap-2">
                <ColorDot color={palette.accent} size={18} shape="square" />
                <Mono>--accent</Mono>
              </span>,
              <Mono key="2">--accent</Mono>,
              <Mono key="3">accent @ 10%</Mono>,
              <Mono key="4">--ink</Mono>,
            ],
            [
              <Mono key="0">danger</Mono>,
              <span key="1" className="inline-flex items-center gap-2">
                <ColorDot color={qualityColors[0]} size={18} shape="square" />
                <Mono>--q1</Mono>
              </span>,
              <Mono key="2">--q1</Mono>,
              <Mono key="3">Q1 @ 10%</Mono>,
              <Mono key="4">--q1</Mono>,
            ],
            [
              <Mono key="0">neutral</Mono>,
              <span key="1" className="inline-flex items-center gap-2">
                <ColorDot color="rgba(14,14,16,0.4)" size={18} shape="square" />
                <Mono>--fg-mute</Mono>
              </span>,
              <Mono key="2">--fg-dim</Mono>,
              <Mono key="3">--paper-2</Mono>,
              <Mono key="4">--ink</Mono>,
            ],
          ]}
        />
      </div>

      <div className="mt-[22px] grid grid-cols-3 gap-[18px]">
        <Card padded>
          <SubStamp>Anatomy</SubStamp>
          <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
            <li>4 px stripe left edge</li>
            <li>14 px glyph · 24 px column</li>
            <li>Title 13 / 700, text 12 / 1.55 / fg-dim</li>
            <li>Optional action button (sm) at right</li>
            <li>16 px vertical · 18 px horizontal padding</li>
          </ul>
        </Card>
        <Card padded>
          <SubStamp>Dismissibility</SubStamp>
          <p className="text-[13px] leading-[1.55] text-fg-dim">
            Alerts{" "}
            <strong className="font-bold">do not dismiss themselves</strong>.
            They persist until the condition that caused them changes or the
            user explicitly closes them (× in the top right). For transient
            feedback, use a toast.
          </p>
        </Card>
        <Card padded>
          <SubStamp>Stacking</SubStamp>
          <p className="text-[13px] leading-[1.55] text-fg-dim">
            Multiple alerts stack with a 14 px gap. Order by severity: danger →
            warning → success → info → neutral. Cap at 3 visible; collapse the
            rest behind a "+ N more" pill.
          </p>
        </Card>
      </div>
    </Section>
  );
}

/* -------- 19 · TOOLTIPS -------- */

export function TooltipsSection() {
  return (
    <Section
      id="tooltips"
      num="19 · Component · Tooltips"
      title="Three jobs, one chassis."
      tone="tinted"
      intro={
        <>
          Tooltips explain (label tip), reveal (data tip on a map point or
          chart), or onboard (coach mark). All three share the ink chassis, the
          8 px tail, and the 200 ms hover delay. Never use a tooltip for content
          the user needs to act on — that's an alert or a popover.
        </>
      }
    >
      <div className="grid grid-cols-3 gap-5">
        <Card padded={false}>
          <div className="grid min-h-[180px] place-items-center bg-paper px-8 py-12">
            <Tooltip kind="label" content="Open command bar" open>
              <span className="rounded-lg border border-line-strong bg-cream px-3.5 py-2 font-mono text-[11px] font-bold tracking-[1px]">
                ⌘ K
              </span>
            </Tooltip>
          </div>
          <div className="border-t border-line bg-cream px-3.5 py-3">
            <div className="text-[12.5px] font-bold">Label tip</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-dim">
              12 / 600 cream · 8 / 12 padding · arrow center
            </div>
          </div>
        </Card>

        <Card padded={false}>
          <div className="grid min-h-[180px] place-items-center bg-paper px-8 py-12">
            <Tooltip
              kind="data"
              open
              content={
                <>
                  <div className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-accent">
                    Hazard · pothole
                  </div>
                  <div className="mt-1 font-bold text-cream">
                    Confirmed 3× in 48 h
                  </div>
                  <div className="mt-1 text-[11px] text-cream/60">
                    SS38 · KM 14.2 · Stelvio east ramp
                  </div>
                </>
              }
            >
              <svg width="40" height="40" viewBox="0 0 40 40">
                <circle
                  cx="20"
                  cy="20"
                  r="10"
                  fill="#FF6A1A"
                  stroke="#F5EFE6"
                  strokeWidth="2"
                />
                <text
                  x="20"
                  y="24"
                  textAnchor="middle"
                  fill="#F5EFE6"
                  className="font-mono text-[11px] font-extrabold"
                >
                  !
                </text>
              </svg>
            </Tooltip>
          </div>
          <div className="border-t border-line bg-cream px-3.5 py-3">
            <div className="text-[12.5px] font-bold">Data tip</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-dim">
              Stamp + title + meta · 220 max-width · 200 ms delay
            </div>
          </div>
        </Card>

        <Card padded={false}>
          <div className="grid min-h-[180px] place-items-center bg-paper px-8 py-12">
            <Tooltip
              kind="coach"
              open
              content={
                <>
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <div className="font-mono text-[11px] font-bold uppercase tracking-[1.5px] text-accent">
                      Tip · 3 of 5
                    </div>
                    <div className="font-mono text-[10px] text-cream/50">
                      ●●●○○
                    </div>
                  </div>
                  <div className="mb-1 font-bold text-cream">
                    Heatmap of curves discovered
                  </div>
                  <div className="text-[11px] leading-[1.5] text-cream/65">
                    Fun Zones rank road clusters by curviness. Tap one to see
                    the segments behind it.
                  </div>
                  <div className="mt-2.5 flex gap-1.5">
                    <Button variant="on-dark" size="sm">
                      Skip
                    </Button>
                    <Button variant="accent" size="sm">
                      Next
                    </Button>
                  </div>
                </>
              }
            >
              <div className="grid h-9 w-20 place-items-center rounded-[10px] border border-line bg-cream text-[12px] font-bold shadow-[0_0_0_4px_rgba(255,106,26,0.18)]">
                Fun Zones
              </div>
            </Tooltip>
          </div>
          <div className="border-t border-line bg-cream px-3.5 py-3">
            <div className="text-[12.5px] font-bold">Coach mark</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-dim">
              Stamp + step counter + title + body + Skip / Next
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-7">
        <SubStamp>Placement &amp; tail</SubStamp>
        <Card padded className="!p-9">
          <div className="grid grid-cols-4 place-items-center gap-9">
            {(["above", "below", "left", "right"] as const).map((p) => (
              <div key={p} className="text-center">
                <Tooltip kind="label" placement={p} content={cap(p)} open>
                  <span className="block h-8 w-20 rounded-md bg-paper" />
                </Tooltip>
                <div className="mt-8 font-mono text-[10px] uppercase tracking-[1px] text-fg-dim">
                  {p === "above" ? "Above · default" : p.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-7 grid grid-cols-2 gap-[22px]">
        <Card padded className="!p-6">
          <SubStamp>Geometry</SubStamp>
          <CodeBlock>
            <span className="text-cream">background: </span>
            <CN>--ink</CN>
            {"\n"}
            <span className="text-cream">color: </span>
            <CN>--cream</CN>
            {"\n"}
            <span className="text-cream">radius: </span>
            <CN>6</CN> (label) · <CN>8</CN> (data) · <CN>10</CN> (coach)
            {"\n"}
            <span className="text-cream">padding: </span>
            <CN>6/10</CN> · <CN>10/12</CN> · <CN>12/14</CN>
            {"\n"}
            <span className="text-cream">font: </span>
            <CN>12 / 600</CN> (label) · sans 13/700 + meta (data)
            {"\n"}
            <span className="text-cream">tail: </span>
            <CN>8 px</CN> square · <CN>45deg</CN> · -4 offset
            {"\n"}
            <span className="text-cream">shadow: </span>
            <CN>0 8 24 ink @ 20%</CN>
            {"\n"}
            <span className="text-cream">delay: </span>
            <CN>200 ms</CN> in · <CN>100 ms</CN> out
            {"\n"}
            <span className="text-cream">max-width: </span>
            <CN>220 px</CN> (data) · <CN>280 px</CN> (coach)
          </CodeBlock>
        </Card>
        <Card padded className="!p-6">
          <SubStamp>Rules</SubStamp>
          <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[1.7] text-fg-dim">
            <li>
              <strong className="font-bold text-ink">Never on touch.</strong>{" "}
              Label tips are mouse-only — surface the label inline on mobile.
            </li>
            <li>
              <strong className="font-bold text-ink">
                Always above first.
              </strong>{" "}
              Flip below only if clipped by viewport top.
            </li>
            <li>
              <strong className="font-bold text-ink">
                One tooltip on screen.
              </strong>{" "}
              Opening a new one immediately closes the previous.
            </li>
            <li>
              <strong className="font-bold text-ink">
                No links inside label or data tips.
              </strong>{" "}
              Tap targets only in coach marks.
            </li>
            <li>
              <strong className="font-bold text-ink">
                Don't tip the obvious.
              </strong>{" "}
              Icons with adjacent text don't need a tooltip.
            </li>
          </ul>
        </Card>
      </div>
    </Section>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* -------- 20 · TOASTS -------- */

// Neutral glyph (three horizontal lines) — the Toast component ships
// info/success/warning/danger; "neutral" comes from passing a custom
// glyph + relying on the default info chrome.
function NeutralGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16">
      <path
        d="M 2 4 L 14 4 M 2 8 L 14 8 M 2 12 L 14 12"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ToastsSection() {
  return (
    <Section
      id="toasts"
      num="20 · Component · Toasts"
      title={
        <>
          Transient,
          <br />
          top-right.
        </>
      }
      intro={
        <>
          For ephemeral feedback after a user action: GPX exported, hazard
          reported, ride synced, photo uploaded. Slides in from the right of the
          viewport, auto-dismisses after 4 s, max 3 stacked. Toasts{" "}
          <em>never</em> carry critical info — if the user must respond to it,
          it's an alert.
        </>
      }
    >
      {/* Live region demo — paper-tinted card with toasts pinned top-right */}
      <Card padded={false} className="relative min-h-[340px] bg-paper">
        <div className="px-5 py-5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-mute">
          TOAST REGION · top: 20 · right: 20 · width: 360
        </div>
        <div className="absolute right-5 top-[60px] flex w-[360px] flex-col gap-2.5">
          <Toast
            intent="success"
            title="GPX exported"
            actionLabel="Open"
            onAction={() => {}}
            onClose={() => {}}
            showProgress
          >
            Alps_Loop_Day_1.gpx · 218 KB
          </Toast>
          <Toast
            intent="info"
            glyph={<NeutralGlyph />}
            title="Ride synced from iPhone"
            onClose={() => {}}
            showProgress
          >
            Stelvio Loop · 186 km · 4h 12m
          </Toast>
          <Toast
            intent="danger"
            title="Couldn't push to phone"
            actionLabel="Retry now"
            onAction={() => {}}
            onClose={() => {}}
            showProgress
          >
            Phone unreachable for 6 minutes. We'll retry automatically.
          </Toast>
        </div>
      </Card>

      {/* Anatomy + Geometry */}
      <div className="mt-7 grid grid-cols-2 gap-[22px]">
        <Card padded={false}>
          <div className="border-b border-line px-[18px] py-4">
            <SubStamp>Anatomy</SubStamp>
          </div>
          <div className="bg-paper px-6 py-6">
            <div className="mx-auto max-w-[360px]">
              <Toast
                intent="success"
                title="GPX exported"
                actionLabel="Open"
                onAction={() => {}}
                onClose={() => {}}
                showProgress
              >
                Alps_Loop_Day_1.gpx · 218 KB
              </Toast>
            </div>
          </div>
          <div className="border-t border-line px-[18px] py-3.5 text-[12px] leading-[1.6] text-fg-dim">
            <strong className="font-bold text-ink">Glyph</strong> 14 px · intent
            color · <strong className="font-bold text-ink">Body</strong> title
            13/700 ink + text 12/fg-dim ·{" "}
            <strong className="font-bold text-ink">Action</strong> optional,
            mono link-style ·{" "}
            <strong className="font-bold text-ink">Close</strong> 16 px ×
            fg-mute · <strong className="font-bold text-ink">Progress</strong> 2
            px bar, draining 4 s linear
          </div>
        </Card>
        <Card padded className="!p-6">
          <SubStamp>Geometry</SubStamp>
          <CodeBlock>
            <span className="text-cream">background: </span>
            <CN>--cream</CN>
            {"\n"}
            <span className="text-cream">border: </span>
            <CN>1 px --line-strong</CN>
            {"\n"}
            <span className="text-cream">radius: </span>
            <CN>10</CN>
            {"\n"}
            <span className="text-cream">padding: </span>
            <CN>12 / 14</CN>
            {"\n"}
            <span className="text-cream">shadow: </span>
            <CN>0 12 32 ink @ 12%</CN>
            {"\n"}
            <span className="text-cream">width: </span>
            <CN>360 px</CN> (max <CN>420</CN>){"\n"}
            <span className="text-cream">gap (stack): </span>
            <CN>10 px</CN>
            {"\n"}
            <span className="text-cream">slide-in: </span>
            <CN>translateX(20) → 0 · 180 ms</CN>
            {"\n"}
            <span className="text-cream">auto-dismiss: </span>
            <CN>4 s</CN> default · <CN>6 s</CN> danger
            {"\n"}
            <span className="text-cream">on-hover: </span>
            <CN>pause timer</CN>
          </CodeBlock>
        </Card>
      </div>

      {/* Intents */}
      <div className="mt-7">
        <SubStamp>Intents</SubStamp>
        <TokenTable
          columns={[
            { label: "Intent", size: "120px" },
            { label: "Glyph" },
            { label: "Progress" },
            { label: "Lifetime" },
            { label: "Use" },
          ]}
          rows={[
            [
              <Mono key="0">success</Mono>,
              <Mono key="1">check · Q5</Mono>,
              <Mono key="2">Q5</Mono>,
              <Mono key="3">4 s</Mono>,
              "Action completed",
            ],
            [
              <Mono key="0">neutral</Mono>,
              <Mono key="1">lines · fg-dim</Mono>,
              <Mono key="2">--ink</Mono>,
              <Mono key="3">4 s</Mono>,
              "Sync, background update",
            ],
            [
              <Mono key="0">warning</Mono>,
              <Mono key="1">triangle · accent</Mono>,
              <Mono key="2">--accent</Mono>,
              <Mono key="3">5 s</Mono>,
              "Recoverable problem",
            ],
            [
              <Mono key="0">danger</Mono>,
              <Mono key="1">x-circle · Q1</Mono>,
              <Mono key="2">--q1</Mono>,
              <Mono key="3">6 s</Mono>,
              "Action failed, retryable",
            ],
          ]}
        />
      </div>

      {/* Do / Don't */}
      <DoDontGrid
        className="mt-7"
        left={[
          {
            kind: "do",
            title: "Confirm the verb.",
            body: "“GPX exported.” “Ride synced.” “Bike added.” Past-tense, declarative, no period needed.",
          },
          {
            kind: "do",
            title: "Pause on hover.",
            body: "If the user hovers a toast, freeze the progress bar. Resume on mouse-leave. They might want to read it twice.",
          },
          {
            kind: "do",
            title: "Cap at 3 stacked.",
            body: "When a fourth arrives, oldest slides out left.",
          },
        ]}
        right={[
          {
            kind: "dont",
            title: "Don't put critical info in a toast.",
            body: "A toast can disappear. “Stelvio closed Oct 31” is an alert; “Itinerary pushed” is a toast.",
          },
          {
            kind: "dont",
            title: "Don't use a toast for a long story.",
            body: "Two lines max — title + sub. If you need more, link to it from the toast action.",
          },
          {
            kind: "dont",
            title: "Don't toast on every interaction.",
            body: "Reserve for actions that left the page — a save the user can't see, a sync that happened elsewhere. Inline changes don't need a toast.",
          },
        ]}
      />
    </Section>
  );
}
