"use client";
import { t } from "@/i18n";
import { QUALITY_BAND_COLORS } from "@/lib/planner/quality-bands";
import type { FlaggedSection } from "@/lib/planner/types";

/**
 * Flagged-section card (design: Inspect § 03): rough sections carry a
 * REROUTE action, unmeasured ones an INSPECT action. Clicking the card
 * itself opens the section's Road Preview and flies the map to it.
 */
interface FlaggedSectionCardProps {
  flag: FlaggedSection;
  selected: boolean;
  onOpen: (segmentId: string) => void;
  onReroute: (segmentId: string) => void;
}

const FLAG_COPY: Record<FlaggedSection["kind"], string> = {
  rough: "below your Good-or-better floor",
  no_data: "no rider passes — verify before you commit",
};

export function FlaggedSectionCard({
  flag,
  selected,
  onOpen,
  onReroute,
}: FlaggedSectionCardProps) {
  const tone =
    flag.kind === "rough"
      ? QUALITY_BAND_COLORS.rough
      : QUALITY_BAND_COLORS.no_data;
  const action = flag.kind === "rough" ? "REROUTE" : "INSPECT";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Preview flagged section: ${flag.label}`}
      onClick={() => onOpen(flag.segmentId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(flag.segmentId);
        }
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-cream p-3 transition hover:border-line-strong ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: tone, boxShadow: `0 0 0 4px ${tone}22` }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold tracking-[-0.1px] text-ink">
          {flag.label}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-fg-dim">
          {t(FLAG_COPY[flag.kind])}
        </div>
      </div>
      <button
        type="button"
        aria-label={`${action === "REROUTE" ? "Reroute around" : "Inspect"} flagged section: ${flag.label}`}
        onClick={(event) => {
          event.stopPropagation();
          if (action === "REROUTE") onReroute(flag.segmentId);
          else onOpen(flag.segmentId);
        }}
        className="shrink-0 rounded-lg border border-accent bg-transparent px-3 py-[7px] font-mono text-[10.5px] font-bold tracking-[0.5px] text-accent transition hover:bg-accent/10"
      >
        {action}
      </button>
    </div>
  );
}
