import { useState } from "react";
import { Section, SubStamp } from "../Section";
import {
  Card,
  NumberGrid,
  RadioCardGroup,
  SegmentedControl,
  Slider,
  SwatchPicker,
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

  return (
    <Section
      id="controls"
      num="09 · Form controls"
      title="Toggle, segment, slider, radio."
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
    </Section>
  );
}
