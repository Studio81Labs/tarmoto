import { cn } from "../../utils/cn";

export interface FieldChromeOptions {
  tone?: "paper" | "cream";
  disabled?: boolean;
  error?: boolean;
  hasLeading?: boolean;
  hasTrailing?: boolean;
}

/**
 * Unified field chrome (§09): 8px radius, ink-@22% hairline, accent focus
 * border + 3px accent-@18% ring. Error swaps the border to Q1. Leading /
 * trailing flags reserve room for an icon or chevron/unit adornment.
 * Supersedes the old `fieldClasses` in Input.tsx.
 */
export function fieldChrome(opts: FieldChromeOptions = {}): string {
  const { tone = "paper", disabled, error, hasLeading, hasTrailing } = opts;
  return cn(
    "w-full rounded-lg border px-3 py-2 font-sans text-sm text-ink",
    "placeholder:text-fg-mute transition outline-none",
    tone === "cream" ? "bg-cream" : "bg-paper",
    hasLeading && "pl-9",
    hasTrailing && "pr-9",
    error
      ? "border-quality-q1 focus:border-quality-q1 focus:ring-[3px] focus:ring-quality-q1/[0.18]"
      : "border-line-strong focus:border-accent focus:ring-[3px] focus:ring-accent/[0.18]",
    disabled && "cursor-not-allowed opacity-60",
  );
}
