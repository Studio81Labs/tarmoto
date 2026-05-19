import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Button · the "commit" surface. Spec: §17.
 * Three sizes (sm 32 · md 40 · lg 48) × six variants
 * (primary · accent · secondary · ghost · danger · on-dark).
 *
 * Use a Pill (§08) for filter chips, toolbar items, status indicators
 * — Button is for verbs that change state.
 */
export type ButtonVariant =
  | "primary"
  | "accent"
  | "secondary"
  | "ghost"
  | "danger"
  | "on-dark";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretches to fill its container. Default in panels per spec. */
  block?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  type?: "button" | "submit" | "reset";
}

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-8 px-3.5 text-xs rounded-lg",
  md: "h-10 px-[18px] text-[13px] rounded-[10px]",
  lg: "h-12 px-[22px] text-sm rounded-xl",
};

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-cream border-transparent hover:bg-tarmac disabled:hover:bg-ink",
  accent:
    "bg-accent text-ink border-transparent hover:bg-accent-hot disabled:hover:bg-accent",
  secondary: "bg-transparent text-ink border-line-strong hover:bg-paper",
  ghost:
    "bg-transparent text-fg-dim border-transparent hover:bg-paper hover:text-ink",
  danger:
    "bg-transparent text-quality-q1 border-quality-q1 hover:bg-quality-q1/10",
  "on-dark": "bg-cream/10 text-cream border-cream/15 hover:bg-cream/15",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      block = false,
      loading = false,
      leftIcon,
      rightIcon,
      type = "button",
      className,
      disabled,
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center gap-2 border whitespace-nowrap",
          "font-sans font-bold select-none",
          "transition-colors duration-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          sizeClass[size],
          variantClass[variant],
          block && "flex w-full",
          className,
        )}
        {...rest}
      >
        {loading ? (
          <span
            aria-hidden="true"
            className="inline-block size-3 animate-spin rounded-full border-2 border-current/30 border-t-current"
          />
        ) : (
          leftIcon
        )}
        <span>{children}</span>
        {!loading && rightIcon}
      </button>
    );
  },
);
