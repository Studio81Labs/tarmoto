import { useState } from "react";
import { Section, SubStamp } from "../Section";
import {
  Card,
  Mono,
  NumberGrid,
  RadioCardGroup,
  SegmentedControl,
  Slider,
  SwatchPicker,
  Toggle,
} from "@tarmoto/ui";

/* -------- 09 · FORM CONTROLS -------- */

export function ControlsSection() {
  const [scenic, setScenic] = useState(true);
  const [gravel, setGravel] = useState(false);
  const [mapMode, setMapMode] = useState<"paper" | "light" | "dark">("paper");
  const [palette, setPalette] = useState<"traffic" | "muted" | "mono">("muted");
  const [distance, setDistance] = useState(186);
  const [ride, setRide] = useState<"twisty" | "scenic" | "relaxed">("twisty");
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
        <Card padded>
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
        </Card>

        {/* Segmented */}
        <Card padded>
          <SubStamp>Segmented control</SubStamp>
          <div className="flex flex-col gap-3.5">
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
        </Card>

        {/* Slider */}
        <Card padded>
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
          </div>
          <Mono className="mt-2 block text-[11px] text-fg-dim">
            {distance} km
          </Mono>
        </Card>

        {/* Radio · stacked */}
        <Card padded>
          <SubStamp>Radio · stacked cards</SubStamp>
          <RadioCardGroup<"twisty" | "scenic" | "relaxed">
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
              {
                value: "relaxed",
                label: "Relaxed loop",
                help: "Smooth roads, longer breaks",
              },
            ]}
          />
        </Card>

        {/* Day picker grid */}
        <Card padded>
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
        <Card padded>
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
