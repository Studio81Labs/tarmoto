import { cn } from "../utils/cn";
import { fieldClasses } from "./Input";

/**
 * Textarea · multi-line text field. Spec: §09.
 *
 * Shares the unified field chrome with `Input` / `Select`; `resize-none`
 * keeps the modal/panel layouts stable. See `Input` for the `tone`
 * rationale and labelling guidance.
 */
export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  tone?: "paper" | "cream";
  id?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  className?: string;
}

export function Textarea({
  value,
  onChange,
  tone = "paper",
  id,
  rows = 3,
  placeholder,
  disabled = false,
  ariaLabel,
  maxLength,
  className,
}: TextareaProps) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value)}
      className={cn(fieldClasses(tone, disabled), "resize-none", className)}
    />
  );
}
