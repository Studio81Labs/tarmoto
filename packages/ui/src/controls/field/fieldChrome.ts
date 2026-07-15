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
 *
 * Native fields (Input/Textarea) surface focus via the `:focus` pseudo-class;
 * react-aria triggers (Select/Combobox/DatePicker/TimePicker/DateTimePicker)
 * do not match `:focus` reliably and instead expose a `data-focused`
 * attribute. Both are mirrored so the accent ring fires across the whole
 * family. The variant a given consumer can't satisfy is inert.
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
      ? "border-quality-q1 focus:border-quality-q1 focus:ring-[3px] focus:ring-quality-q1/[0.18] data-[focused]:border-quality-q1 data-[focused]:ring-[3px] data-[focused]:ring-quality-q1/[0.18]"
      : "border-line-strong focus:border-accent focus:ring-[3px] focus:ring-accent/[0.18] data-[focused]:border-accent data-[focused]:ring-[3px] data-[focused]:ring-accent/[0.18]",
    disabled && "cursor-not-allowed opacity-60",
  );
}
