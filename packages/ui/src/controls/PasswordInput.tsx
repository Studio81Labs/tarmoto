"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Coarse client-side strength estimate for the meter under PasswordInput.
 * A UI hint only — length and character variety — NOT a security oracle;
 * real password policy stays server-side.
 *
 * 0 = empty · 1 = weak (short) · 2 = fair · 3 = good · 4 = strong.
 * Anything under 8 characters is capped at "weak" no matter how varied.
 */
export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

export function passwordStrength(value: string): PasswordStrength {
  if (!value) return 0;
  if (value.length < 8) return 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((re) =>
    re.test(value),
  ).length;
  let score = 2;
  if (value.length >= 12) score += 1;
  if (classes >= 3) score += 1;
  return score as PasswordStrength;
}

const STRENGTH_LABEL: Record<PasswordStrength, string> = {
  0: "",
  1: "Weak",
  2: "Fair",
  3: "Good",
  4: "Strong",
};

// Meter colours ride the quality ramp — the palette already encodes
// bad→good as q1→q5, so strength reuses it instead of new tokens.
const STRENGTH_BAR: Record<PasswordStrength, string> = {
  0: "",
  1: "bg-quality-q1",
  2: "bg-quality-q2",
  3: "bg-quality-q4",
  4: "bg-quality-q5",
};
const STRENGTH_TEXT: Record<PasswordStrength, string> = {
  0: "",
  1: "text-quality-q1",
  2: "text-quality-q2",
  3: "text-quality-q4",
  4: "text-quality-q5",
};

export interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  tone?: "paper" | "cream";
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  minLength?: number;
  maxLength?: number;
  /** Password-manager hint: "current-password" (login) or "new-password". */
  autoComplete?: "current-password" | "new-password";
  error?: boolean;
  hint?: ReactNode;
  hintId?: string | undefined;
  /** Render the strength meter under the field (registration / password change). */
  showStrength?: boolean;
  className?: string;
}

/**
 * PasswordInput · password field with a show/hide toggle and an optional
 * strength meter (§09 field chrome). Shares `fieldChrome` with Input; the
 * eye toggle sits in the trailing slot. Pass an external `<label htmlFor>`
 * + matching `id`, or `ariaLabel`.
 */
export function PasswordInput({
  value,
  onChange,
  tone = "paper",
  id,
  placeholder,
  disabled = false,
  required = false,
  ariaLabel,
  minLength,
  maxLength,
  autoComplete = "current-password",
  error = false,
  hint,
  hintId,
  showStrength = false,
  className,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  // Mirror Input: always resolve an id for `aria-describedby` when a hint is
  // shown, falling back to a generated one for ariaLabel-only fields.
  const autoHintId = useId();
  const resolvedHintId =
    hintId ?? (hint ? (id ? `${id}-hint` : autoHintId) : undefined);
  const strength = showStrength ? passwordStrength(value) : 0;

  return (
    <div className={cn("w-full", className)}>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error || undefined}
          aria-describedby={resolvedHintId}
          minLength={minLength}
          maxLength={maxLength}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          className={fieldChrome({ tone, disabled, error, hasTrailing: true })}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          className="absolute right-3 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-mute transition-colors hover:text-ink disabled:cursor-not-allowed"
        >
          {visible ? (
            /* eye-off */
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
            >
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" x2="22" y1="2" y2="22" />
            </svg>
          ) : (
            /* eye */
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      {showStrength && (
        <div className="mt-1.5">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((seg) => (
              <span
                key={seg}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  seg <= strength ? STRENGTH_BAR[strength] : "bg-ink/10",
                )}
              />
            ))}
          </div>
          {/* Polite live region: announces the label as it changes without
              stealing focus; visually doubles as the meter caption. The
              empty state renders an nbsp so the caption line keeps its
              height and the layout doesn't jump on the first keystroke. */}
          <p
            aria-live="polite"
            className={cn(
              "mt-1 text-right font-mono text-[10px] uppercase tracking-[0.8px]",
              strength === 0 ? "text-fg-mute" : STRENGTH_TEXT[strength],
            )}
          >
            {strength === 0 ? " " : STRENGTH_LABEL[strength]}
          </p>
        </div>
      )}
      {hint && (
        <FieldHint
          {...(resolvedHintId !== undefined ? { id: resolvedHintId } : {})}
          tone={error ? "error" : "default"}
        >
          {hint}
        </FieldHint>
      )}
    </div>
  );
}
