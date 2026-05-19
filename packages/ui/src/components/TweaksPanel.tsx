import { cn } from "../utils/cn";
import { Stamp } from "../atoms/Stamp";
import { SegmentedControl } from "../controls/SegmentedControl";
import { SwatchPicker } from "../controls/SwatchPicker";

/**
 * Tweaks panel · the floating user-prefs surface. Spec: §16.
 * 300 px floating card, cream fill, lift shadow. Four control rows:
 * map mode, palette, density, accent colour.
 *
 * The shape persisted in the host is exactly `TweaksTokens` below.
 */
export type MapMode = "paper" | "light" | "dark";
export type QualityPalette = "traffic" | "muted" | "mono";
export type Density = "comfortable" | "compact";

export interface TweaksTokens {
  mapMode: MapMode;
  palette: QualityPalette;
  density: Density;
  accent: string;
}

export const DEFAULT_TWEAKS: TweaksTokens = {
  mapMode: "paper",
  palette: "traffic",
  density: "comfortable",
  accent: "#FF6A1A",
};

const DEFAULT_ACCENTS = [
  "#FF6A1A",
  "#E8D66A",
  "#6FD38A",
  "#6EB4E8",
  "#C28AE8",
  "#E05A3C",
];

export interface TweaksPanelProps {
  value: TweaksTokens;
  onChange: (next: TweaksTokens) => void;
  onClose?: () => void;
  accentOptions?: ReadonlyArray<string>;
  className?: string;
}

export function TweaksPanel({
  value,
  onChange,
  onClose,
  accentOptions = DEFAULT_ACCENTS,
  className,
}: TweaksPanelProps) {
  const patch = (partial: Partial<TweaksTokens>): void => {
    onChange({ ...value, ...partial });
  };

  return (
    <div
      className={cn(
        "flex w-[300px] flex-col gap-3.5 rounded-[14px] border border-line-strong bg-cream p-[18px]",
        "shadow-[0_24px_60px_rgba(14,14,16,0.2)]",
        className,
      )}
      role="dialog"
      aria-label="Display tweaks"
    >
      <div className="flex items-center justify-between">
        <Stamp tone="accent">Tweaks</Stamp>
        {onClose && (
          <button
            type="button"
            aria-label="Close tweaks"
            onClick={onClose}
            className="border-0 bg-transparent p-0 text-[18px] leading-none text-fg-mute cursor-pointer hover:text-ink"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Stamp>Map mode</Stamp>
        <SegmentedControl<MapMode>
          ariaLabel="Map mode"
          value={value.mapMode}
          onChange={(v) => patch({ mapMode: v })}
          options={[
            { value: "paper", label: "paper" },
            { value: "light", label: "light" },
            { value: "dark", label: "dark" },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Stamp>Quality palette</Stamp>
        <SegmentedControl<QualityPalette>
          ariaLabel="Quality palette"
          value={value.palette}
          onChange={(v) => patch({ palette: v })}
          options={[
            { value: "traffic", label: "traffic" },
            { value: "muted", label: "muted" },
            { value: "mono", label: "mono" },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Stamp>Density</Stamp>
        <SegmentedControl<Density>
          ariaLabel="Density"
          value={value.density}
          onChange={(v) => patch({ density: v })}
          options={[
            { value: "comfortable", label: "comfortable" },
            { value: "compact", label: "compact" },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Stamp>Accent color</Stamp>
        <SwatchPicker
          ariaLabel="Accent color"
          value={value.accent}
          options={accentOptions}
          onChange={(v) => patch({ accent: v })}
        />
      </div>
    </div>
  );
}
