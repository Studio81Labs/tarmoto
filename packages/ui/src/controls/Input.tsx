import { cn } from "../utils/cn";

/**
 * Input · single-line text field. Spec: §09.
 *
 * The unified field chrome shared with `Select` / `Textarea`: rounded-lg,
 * `border-line-strong`, accent focus border. `tone` matches the field
 * surface to its container (`paper` default on the cream page, `cream`
 * inside a paper card) — `cn` is plain clsx, so a `className` background
 * can't override the default, hence a prop.
 *
 * Pass an external `<label htmlFor>` + matching `id`, or `ariaLabel`.
 */
export interface InputProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "search" | "url" | "tel";
  tone?: "paper" | "cream";
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  maxLength?: number;
  className?: string;
}

/** Field chrome shared across the text-style controls. */
export function fieldClasses(tone: "paper" | "cream", disabled?: boolean) {
  return cn(
    "w-full rounded-lg border border-line-strong px-3 py-2 font-sans text-sm text-ink placeholder:text-fg-mute transition",
    tone === "cream" ? "bg-cream" : "bg-paper",
    "focus:border-accent focus:outline-none",
    disabled && "cursor-not-allowed opacity-60",
  );
}

export function Input({
  value,
  onChange,
  type = "text",
  tone = "paper",
  id,
  placeholder,
  disabled = false,
  readOnly = false,
  ariaLabel,
  maxLength,
  className,
}: InputProps) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value)}
      className={cn(fieldClasses(tone, disabled), className)}
    />
  );
}
