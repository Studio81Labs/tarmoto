import { useId, type ReactNode } from "react";
import { cn } from "../utils/cn";
import { fieldChrome } from "./field/fieldChrome";
import { FieldHint } from "./field/FieldHint";

/**
 * Input · single-line text field. Spec: §09.
 * Shares `fieldChrome` with Textarea/Select. `tone` matches the field
 * surface to its container. Pass an external `<label htmlFor>` + matching
 * `id`, or `ariaLabel`.
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
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  /** Virtual-keyboard hint for text-typed fields (e.g. "numeric" for a year). */
  inputMode?:
    "text" | "numeric" | "decimal" | "email" | "tel" | "search" | "url";
  ariaLabel?: string;
  maxLength?: number;
  leadingIcon?: ReactNode;
  error?: boolean;
  hint?: ReactNode;
  hintId?: string | undefined;
  className?: string;
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
  required = false,
  autoFocus = false,
  autoComplete,
  inputMode,
  ariaLabel,
  maxLength,
  leadingIcon,
  error = false,
  hint,
  hintId,
  className,
}: InputProps) {
  // When a hint is shown, always resolve an id so `aria-describedby` can point
  // at it — falling back to a generated id for `ariaLabel`-only fields that
  // pass no `id`/`hintId` (otherwise the hint renders but is invisible to AT).
  const autoHintId = useId();
  const resolvedHintId =
    hintId ?? (hint ? (id ? `${id}-hint` : autoHintId) : undefined);
  return (
    <div className={cn("w-full", className)}>
      <div className="relative">
        {leadingIcon && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-mute"
          >
            {leadingIcon}
          </span>
        )}
        <input
          id={id}
          type={type}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- caller's call:
          // modal name fields and confirm dialogs opt in deliberately.
          autoFocus={autoFocus}
          {...(autoComplete !== undefined ? { autoComplete } : {})}
          {...(inputMode !== undefined ? { inputMode } : {})}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error || undefined}
          aria-describedby={resolvedHintId}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={fieldChrome({
            tone,
            disabled,
            error,
            hasLeading: !!leadingIcon,
          })}
        />
      </div>
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
