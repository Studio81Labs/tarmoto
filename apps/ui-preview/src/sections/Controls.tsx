import { useState } from "react";
import { Section, SubStamp } from "../Section";
import {
  Card,
  FieldLabel,
  Input,
  NumberField,
  NumberGrid,
  RadioCardGroup,
  SegmentedControl,
  Slider,
  SwatchPicker,
  Textarea,
  Toggle,
} from "@tarmoto/ui";
import { CodeBlock, CN, CS } from "./_shared";

/* -------- 09 · FORM CONTROLS -------- */

export function ControlsSection() {
  const [scenic, setScenic] = useState(true);
  const [gravel, setGravel] = useState(false);
  const [mapMode, setMapMode] = useState<"paper" | "light" | "dark">("paper");
  const [palette, setPalette] = useState<"traffic" | "muted" | "mono">("muted");
  const [distance, setDistance] = useState(186);
  const [ride, setRide] = useState<"twisty" | "scenic">("twisty");
  const [days, setDays] = useState(4);
  const [accent, setAccent] = useState("#FF6A1A");

  // Text-field family state
  const [inputTyping, setInputTyping] = useState("brno.rider");
  const [inputIcon, setInputIcon] = useState("mountain pass");
  const [inputError, setInputError] = useState("notanemail");
  const [textareaVal, setTextareaVal] = useState(
    "Challenging hairpins through the Jeseniky ridge — bring rain gear.",
  );
  const [tripKm, setTripKm] = useState(240);
  const [distUnit, setDistUnit] = useState<"km" | "mi">("km");

  return (
    <Section
      id="controls"
      num="09 · Form controls"
      title="Toggle, segment, slider, radio — and the text-field family."
      tone="tinted"
      intro={
        <>
          Four control patterns cover every parameter surface (Trip Planner,
          Account notifications, Tweaks). Same visual language: ink for active,
          paper for inactive, accent only on the active thumb of toggles.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-6">
        {/* Toggle */}
        <Card padded className="!p-6">
          <SubStamp>Toggle</SubStamp>
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between border-b border-line py-2.5 text-[13px]">
              <span>Prefer scenic routes</span>
              <Toggle
                checked={scenic}
                onChange={setScenic}
                ariaLabel="Prefer scenic routes"
              />
            </div>
            <div className="flex items-center justify-between border-b border-line py-2.5 text-[13px]">
              <span>Avoid gravel & unpaved</span>
              <Toggle
                checked={gravel}
                onChange={setGravel}
                ariaLabel="Avoid gravel"
              />
            </div>
          </div>
          <div className="mt-4">
            <CodeBlock>
              {`track: `}
              <CN>34 × 20</CN>
              {` · ink / 0.12 ink\n`}
              {`thumb: `}
              <CN>16</CN>
              {` circle · cream / accent\n`}
              {`gap to track edge: `}
              <CN>2 px</CN>
              {`\n`}
              {`ease: `}
              <CS>{`"left 0.15s"`}</CS>
            </CodeBlock>
          </div>
        </Card>

        {/* Segmented */}
        <Card padded className="!p-6">
          <SubStamp>Segmented control</SubStamp>
          {/* `items-start` is critical — without it the parent flex-column's
           * default `align-items: stretch` expands the inline-flex Segmented
           * track to the full column width, so the active item's `--ink` pill
           * floats inside an oversized paper-tinted track. */}
          <div className="flex flex-col items-start gap-3.5">
            <SegmentedControl<"paper" | "light" | "dark">
              ariaLabel="Map mode"
              value={mapMode}
              onChange={setMapMode}
              options={[
                { value: "paper", label: "paper" },
                { value: "light", label: "light" },
                { value: "dark", label: "dark" },
              ]}
            />
            <SegmentedControl<"traffic" | "muted" | "mono">
              ariaLabel="Quality palette"
              value={palette}
              onChange={setPalette}
              options={[
                { value: "traffic", label: "traffic" },
                { value: "muted", label: "muted" },
                { value: "mono", label: "mono" },
              ]}
            />
          </div>
          <div className="mt-4">
            <CodeBlock>
              {`track: `}
              <CN>--paper</CN>
              {` · 3 px padding · 7 radius\n`}
              {`item: `}
              <CN>6 / 8</CN>
              {` padding · 11 px / 700\n`}
              {`active: `}
              <CN>--ink</CN>
              {` bg · cream fg · 5 radius\n`}
              {`inactive: transparent · fg-dim`}
            </CodeBlock>
          </div>
        </Card>

        {/* Slider */}
        <Card padded className="!p-6">
          <SubStamp>Slider</SubStamp>
          <div className="max-w-[320px]">
            <Slider
              value={distance}
              onChange={setDistance}
              min={80}
              max={300}
              step={1}
              ariaLabel="Distance"
            />
            <div className="mt-1 flex max-w-[320px] justify-between font-mono text-[10px] text-fg-mute">
              <span>80</span>
              <span>300</span>
            </div>
          </div>
          <div className="mt-4">
            <CodeBlock>
              {`rail: `}
              <CN>2</CN>
              {` px line-strong / fg\n`}
              {`thumb: `}
              <CN>16</CN>
              {` circle · --accent\n`}
              {`thumb border: `}
              <CN>2 px</CN>
              {` ink (ringed)\n`}
              {`endcaps: mono / fg-mute · always visible`}
            </CodeBlock>
          </div>
        </Card>

        {/* Radio · stacked */}
        <Card padded className="!p-6">
          <SubStamp>Radio · stacked cards</SubStamp>
          <RadioCardGroup<"twisty" | "scenic">
            name="ride-style"
            value={ride}
            onChange={setRide}
            options={[
              {
                value: "twisty",
                label: "Maximum twisty",
                help: "Fun-factor first, chain passes",
              },
              {
                value: "scenic",
                label: "Scenic balance",
                help: "Views + curves mixed",
              },
            ]}
          />
        </Card>

        {/* Day picker grid */}
        <Card padded className="!p-6">
          <SubStamp>Number grid</SubStamp>
          <NumberGrid
            value={days}
            onChange={setDays}
            options={[2, 3, 4, 5, 6, 7]}
            ariaLabel="Days"
          />
          <p className="mt-3 text-[12px] text-fg-dim">
            Equal-flex chips, mono numbers. Selected = ink fill. Use for finite
            numeric choices (days, gears) — never for time or units.
          </p>
        </Card>

        {/* Swatch picker */}
        <Card padded className="!p-6">
          <SubStamp>Swatch picker</SubStamp>
          <SwatchPicker
            value={accent}
            onChange={setAccent}
            options={[
              "#FF6A1A",
              "#E8D66A",
              "#6FD38A",
              "#6EB4E8",
              "#C28AE8",
              "#E05A3C",
            ]}
            ariaLabel="Accent colour"
          />
          <p className="mt-3 text-[12px] text-fg-dim">
            Curated only — never a free hex picker. Selected = 2 px ink ring.
          </p>
        </Card>
      </div>

      {/* ── Text-field family ── */}
      <p className="mt-10 border-t border-line pt-6 text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim">
        Text-field family
      </p>

      <div className="mt-4 grid grid-cols-2 gap-6">
        {/* Text input · states */}
        <Card padded className="col-span-2 !p-6">
          <SubStamp>Text input · states</SubStamp>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4">
            {/* rest / placeholder */}
            <div>
              <FieldLabel htmlFor="inp-rest">Username</FieldLabel>
              <Input
                id="inp-rest"
                value=""
                onChange={() => {}}
                placeholder="e.g. brno.rider"
              />
            </div>

            {/* focused-typing (live value) */}
            <div>
              <FieldLabel htmlFor="inp-typing">Username</FieldLabel>
              <Input
                id="inp-typing"
                value={inputTyping}
                onChange={setInputTyping}
                placeholder="e.g. brno.rider"
              />
            </div>

            {/* leading icon · search */}
            <div>
              <FieldLabel htmlFor="inp-search">Search routes</FieldLabel>
              <Input
                id="inp-search"
                value={inputIcon}
                onChange={setInputIcon}
                placeholder="mountain pass…"
                leadingIcon={
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                }
              />
            </div>

            {/* disabled */}
            <div>
              <FieldLabel htmlFor="inp-disabled">Account email</FieldLabel>
              <Input
                id="inp-disabled"
                value="adam@studio81labs.com"
                onChange={() => {}}
                disabled
              />
            </div>

            {/* error + hint */}
            <div className="col-span-2">
              <FieldLabel htmlFor="inp-error">Email</FieldLabel>
              <Input
                id="inp-error"
                value={inputError}
                onChange={setInputError}
                type="email"
                error
                hint="Enter a valid email address."
              />
            </div>
          </div>
          <div className="mt-4">
            <CodeBlock>
              {`chrome: `}
              <CN>fieldChrome()</CN>
              {` — border-line-strong → accent on focus\n`}
              {`leading icon: `}
              <CN>absolute left-3</CN>
              {` · pointer-events-none · fg-mute\n`}
              {`error: `}
              <CN>border-danger</CN>
              {` ring · FieldHint tone="error"\n`}
              {`disabled: `}
              <CN>opacity-60 cursor-not-allowed</CN>
            </CodeBlock>
          </div>
        </Card>

        {/* Textarea */}
        <Card padded className="!p-6">
          <SubStamp>Textarea</SubStamp>
          <FieldLabel htmlFor="ta-notes">Trip notes</FieldLabel>
          <Textarea
            id="ta-notes"
            value={textareaVal}
            onChange={setTextareaVal}
            rows={4}
            placeholder="Describe the route…"
            hint="Markdown supported. Visible to riders you share with."
          />
          <div className="mt-4">
            <CodeBlock>
              {`same chrome as Input · `}
              <CN>resize-none</CN>
              {` · leading-relaxed\n`}
              {`hint: `}
              <CN>FieldHint</CN>
              {` tone="default" below the field`}
            </CodeBlock>
          </div>
        </Card>

        {/* NumberField + unit segmented pair */}
        <Card padded className="!p-6">
          <SubStamp>Segmented + input pair</SubStamp>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <FieldLabel htmlFor="nf-distance">Trip distance</FieldLabel>
              <NumberField
                id="nf-distance"
                value={tripKm}
                onChange={setTripKm}
                min={10}
                max={9999}
                step={10}
                unit="KM"
                ariaLabel="Trip distance in kilometres"
              />
            </div>
            <SegmentedControl<"km" | "mi">
              ariaLabel="Distance unit"
              value={distUnit}
              onChange={setDistUnit}
              options={[
                { value: "km", label: "km" },
                { value: "mi", label: "mi" },
              ]}
            />
          </div>
          <div className="mt-4">
            <CodeBlock>
              {`NumberField: border-line-strong · flex stepper column\n`}
              {`unit badge: `}
              <CN>mono 11 px / 700</CN>
              {` · uppercase · fg-mute\n`}
              {`pair: NumberField flex-1 · SegmentedControl inline`}
            </CodeBlock>
          </div>
        </Card>
      </div>
    </Section>
  );
}
