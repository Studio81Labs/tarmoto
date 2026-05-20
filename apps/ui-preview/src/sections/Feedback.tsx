import { useState } from "react";
import { Section, SubStamp } from "../Section";
import { Alert, Button, Card, Mono, Toast, Tooltip } from "@tarmoto/ui";
import { SpecHead, SpecRow } from "./Atoms";

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
          secondary · ghost), plus accent / danger / on-dark.
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
            <StateCol label="LOADING">
              <Button block loading>
                Pushing
              </Button>
            </StateCol>
            <StateCol label="WITH ICON">
              <Button block rightIcon={<span>→</span>}>
                Push to phone
              </Button>
            </StateCol>
            <StateCol label="DISABLED · 40 %">
              <Button block disabled>
                Disabled
              </Button>
            </StateCol>
            <StateCol label="ACCENT">
              <Button variant="accent" block>
                Re-generate
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
          outdated data, GDPR confirmations, info call-outs in settings. Five
          intents share one anatomy: stripe + glyph + title + body + optional
          action.
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
        <Card padded>
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
                  <div className="font-bold text-cream">
                    Tap a road to inspect its quality
                  </div>
                  <div className="mt-1 text-[11px] text-cream/65">
                    The 5-bar glyph shows the average over the last 30 days of
                    contributions.
                  </div>
                </>
              }
            >
              <div className="grid size-10 place-items-center rounded-full bg-cream font-mono text-[14px] font-extrabold text-ink shadow-[0_2px_6px_rgba(14,14,16,0.08)]">
                ?
              </div>
            </Tooltip>
          </div>
          <div className="border-t border-line bg-cream px-3.5 py-3">
            <div className="text-[12.5px] font-bold">Coach mark</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-dim">
              Title + body · 280 max-width · lift shadow
            </div>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* -------- 20 · TOASTS -------- */

export function ToastsSection() {
  const [count, setCount] = useState(0);

  return (
    <Section
      id="toasts"
      num="20 · Component · Toasts"
      title="Transient, dismissable."
      intro={
        <>
          Toasts confirm a transient outcome — saved, copied, sent. Pair with a
          headless queue (sonner / custom) for stacking. Anything that needs to
          persist until the user acts is an Alert, not a toast.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3.5">
        <Toast
          intent="success"
          title="Itinerary pushed"
          actionLabel="UNDO"
          onAction={() => {}}
          onClose={() => {}}
          showProgress
        >
          All 4 days are now on Luca's iPhone 16 Pro.
        </Toast>
        <Toast
          intent="info"
          title="Copied share link"
          onClose={() => {}}
          showProgress
        >
          tarmoto.app/r/alps-loop-04
        </Toast>
        <Toast
          intent="warning"
          title="GPS signal weak"
          actionLabel="DETAILS"
          onAction={() => {}}
          onClose={() => {}}
        >
          Switching to estimated position for the next 200 m.
        </Toast>
        <Toast intent="danger" title="Sync failed" onClose={() => {}}>
          We'll keep retrying in the background.
        </Toast>
      </div>

      <div className="mt-7">
        <SubStamp>Live trigger</SubStamp>
        <div className="flex items-center gap-3">
          <Button onClick={() => setCount((n) => n + 1)}>Fire a toast</Button>
          <Mono className="text-[11px] text-fg-dim">
            Fired {count} {count === 1 ? "time" : "times"}
          </Mono>
        </div>
        <p className="mt-3 text-[13px] leading-[1.55] text-fg-dim">
          The Toast component is presentational only — wire it into your own
          queue + auto-dismiss timing. The 4-second progress bar is a built-in
          animation; combine it with{" "}
          <Mono className="text-ink">setTimeout</Mono> for actual removal.
        </p>
      </div>
    </Section>
  );
}
