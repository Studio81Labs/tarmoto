import { useId, type ChangeEvent } from "react";
import { cn } from "../utils/cn";
import { Mono } from "../atoms/Mono";

/**
 * Slider · single-handle range. Spec: §09.
 * Rail 2 px line-strong · thumb 16 circle accent ringed in ink.
 * End-caps are mono / fg-mute and always visible.
 */
export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  ariaLabel?: string;
  className?: string;
  /** Optional unit suffix shown next to the end-caps (e.g. "km"). */
  unit?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  className,
  unit,
}: SliderProps) {
  const id = useId();
  const pct = ((value - min) / Math.max(1, max - min)) * 100;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="relative h-7">
        {/* rail */}
        <div className="absolute inset-x-0 top-[13px] h-px bg-line-strong" />
        {/* fill */}
        <div
          className="absolute top-[13px] h-px bg-ink"
          style={{ left: 0, width: `${pct}%` }}
        />
        {/* thumb */}
        <div
          aria-hidden="true"
          className="absolute top-1.5 size-4 -translate-x-1/2 rounded-full border-2 border-ink bg-accent"
          style={{ left: `${pct}%` }}
        />
        {/* invisible native input handles all input semantics */}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange(Number(e.target.value))
          }
          aria-label={ariaLabel}
          className="absolute inset-x-0 top-1.5 size-full cursor-pointer opacity-0"
          style={{ height: 16 }}
        />
      </div>
      <div className="flex justify-between">
        <Mono className="text-[10px] text-fg-mute">
          {min}
          {unit ? ` ${unit}` : ""}
        </Mono>
        <Mono className="text-[10px] text-fg-mute">
          {max}
          {unit ? ` ${unit}` : ""}
        </Mono>
      </div>
    </div>
  );
}
