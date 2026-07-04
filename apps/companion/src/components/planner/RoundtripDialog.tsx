"use client";
import { t } from "@/i18n";
import { useState } from "react";
import { Button, NumberField, Select } from "@tarmoto/ui";
import {
  ROAD_PREFERENCE_LABELS,
  type RoadPreference,
} from "@/lib/planner/prefs";
import type { RoundtripOptions } from "@/lib/planner/types";

/**
 * Roundtrip options dialog (revision 3 §E): opened by "Draft route" when
 * no finish exists. An intentional modal — drafting a loop is a discrete
 * generate action, not a live-tuned setting. The loop distance here is
 * INDEPENDENT of the multi-day daily-km field.
 */
interface RoundtripDialogProps {
  open: boolean;
  /** Trip-wide road preference — the dialog's starting value. */
  defaultPreference: RoadPreference;
  /** Starting values — the last confirmed options when recalculating. */
  initialDistanceKm?: number;
  initialDirection?: RoundtripOptions["direction"];
  /** True when the route is already a drafted loop being recalculated. */
  recalculate?: boolean;
  /** True when a map region is drawn — it wins over the direction pick. */
  hasRegion: boolean;
  drafting: boolean;
  onClose: () => void;
  onConfirm: (
    opts: Pick<RoundtripOptions, "distanceKm" | "direction" | "preference">,
  ) => void;
}

const DIRECTIONS: Array<RoundtripOptions["direction"]> = [
  "NW",
  "N",
  "NE",
  "W",
  "random",
  "E",
  "SW",
  "S",
  "SE",
];

const DIRECTION_LABELS: Record<RoundtripOptions["direction"], string> = {
  N: "N",
  NE: "NE",
  E: "E",
  SE: "SE",
  S: "S",
  SW: "SW",
  W: "W",
  NW: "NW",
  random: "?",
};

const PREFERENCE_OPTIONS: RoadPreference[] = [
  "efficient_loop",
  "direct",
  "balanced",
  "scenic_balance",
  "maximum_twisty",
];

export function RoundtripDialog({
  open,
  defaultPreference,
  initialDistanceKm = 250,
  initialDirection = "random",
  recalculate = false,
  hasRegion,
  drafting,
  onClose,
  onConfirm,
}: RoundtripDialogProps) {
  const [distanceKm, setDistanceKm] = useState(initialDistanceKm);
  const [direction, setDirection] =
    useState<RoundtripOptions["direction"]>(initialDirection);
  const [preference, setPreference] =
    useState<RoadPreference>(defaultPreference);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Roundtrip options")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-sm rounded-[14px] border border-line-strong bg-cream p-5 shadow-[0_18px_48px_rgba(14,14,16,0.3)]">
        <h2 className="font-sans text-[17px] font-extrabold tracking-[-0.3px] text-ink">
          {recalculate ? t("Recalculate roundtrip") : t("Draft roundtrip")}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-dim">
          {recalculate
            ? t(
                "Propose a fresh loop from your start — same options as last time unless you change them. ",
              )
            : t(
                "A loop out and back to your start. The distance is a soft target — good roads decide the final length. ",
              )}
        </p>

        <label
          htmlFor="roundtrip-distance"
          className="mb-1 mt-4 block text-xs text-fg-dim"
        >
          {t("Loop distance")}
        </label>
        <NumberField
          id="roundtrip-distance"
          min={50}
          max={1500}
          step={25}
          value={distanceKm}
          onChange={setDistanceKm}
          tone="cream"
        />

        <p className="mb-1 mt-4 text-xs text-fg-dim">{t("Direction")}</p>
        {hasRegion ? (
          <p className="mb-2 text-[11px] leading-snug text-fg-mute">
            {t("Your drawn region decides where the loop looks for roads. ")}
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-1">
          {DIRECTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={direction === option}
              aria-label={
                option === "random"
                  ? t("Random direction")
                  : t("Direction {dir}", { dir: option })
              }
              onClick={() => setDirection(option)}
              className={`rounded-[8px] border py-2.5 text-center font-mono text-[12px] font-bold transition ${
                direction === option
                  ? "border-ink bg-ink text-cream"
                  : "border-line bg-cream text-fg-dim hover:text-ink"
              }`}
            >
              {DIRECTION_LABELS[option]}
            </button>
          ))}
        </div>

        <label
          htmlFor="roundtrip-preference"
          className="mb-1 mt-4 block text-xs text-fg-dim"
        >
          {t("Road preference")}
        </label>
        <Select
          id="roundtrip-preference"
          value={preference}
          onChange={(value) => setPreference(value as RoadPreference)}
          tone="cream"
        >
          {PREFERENCE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {ROAD_PREFERENCE_LABELS[option]}
            </option>
          ))}
        </Select>

        <div className="mt-5 flex gap-2">
          <Button variant="secondary" size="md" block onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="accent"
            size="md"
            block
            uppercase
            loading={drafting}
            disabled={drafting}
            onClick={() => onConfirm({ distanceKm, direction, preference })}
          >
            {recalculate ? t("Recalculate") : t("Draft roundtrip")}
          </Button>
        </div>
      </div>
    </div>
  );
}
