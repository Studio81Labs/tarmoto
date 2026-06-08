import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Button · the "commit" surface. Spec: §17.
 * Three sizes (sm 34 · md 40 · lg 48) × seven variants
 * (primary · accent · secondary · ghost · danger · danger-solid · on-dark).
 * `sm` is 34 px so it lines up with the 34 px form inputs/selects.
 *
 * `danger` is the low-emphasis outline (e.g. a "Delete…" entry point that
 * opens a confirm); `danger-solid` is the filled commit used for the
 * destructive *confirm* itself inside that dialog. Both use the `quality-q1`
 * token; the solid pairs it with `text-ink` (≈4.5:1, matching the brand's
 * ink-on-warm CTAs) rather than cream (which fails AA on `sm`).
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
  | "danger-solid"
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
  /**
   * Square icon-only button: drops the text label and horizontal padding so
   * the icon (passed as `children`) sits centred. Always pair with an
   * `aria-label` so the control stays announced.
   */
  iconOnly?: boolean;
  /** Uppercase the label with the CTA letter-spacing (header action style). */
  uppercase?: boolean;
  /**
   * Render as a link instead of a `<button>` — pass your router's link
   * component (e.g. Next's `<Link>`) wrapping the supplied class + content.
   * Keeps `@tarmoto/ui` framework-agnostic, mirroring `DataTable.renderLink`.
   */
  renderLink?: (props: { className: string; children: ReactNode }) => ReactNode;
  type?: "button" | "submit" | "reset";
}

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-[34px] px-3.5 text-xs rounded-lg",
  md: "h-10 px-[18px] text-[13px] rounded-[10px]",
  lg: "h-12 px-[22px] text-sm rounded-xl",
};

const iconSizeClass: Record<ButtonSize, string> = {
  sm: "h-[34px] w-[34px] text-xs rounded-lg",
  md: "h-10 w-10 text-[13px] rounded-[10px]",
  lg: "h-12 w-12 text-sm rounded-xl",
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
  "danger-solid":
    "bg-quality-q1 text-ink border-transparent hover:brightness-95 disabled:hover:brightness-100",
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
      iconOnly = false,
      uppercase = false,
      renderLink,
      type = "button",
      className,
      disabled,
      children,
      ...rest
    },
    ref,
  ) {
    const spinner = (
      <span
        aria-hidden="true"
        className="inline-block size-3 animate-spin rounded-full border-2 border-current/30 border-t-current"
      />
    );
    const classes = cn(
      "inline-flex items-center justify-center gap-2 border whitespace-nowrap",
      "font-sans font-bold select-none cursor-pointer",
      "transition-colors duration-100",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
      "disabled:opacity-40 disabled:cursor-not-allowed",
      iconOnly ? iconSizeClass[size] : sizeClass[size],
      variantClass[variant],
      uppercase && "uppercase tracking-[0.4px]",
      block && "flex w-full",
      className,
    );
    const body = iconOnly ? (
      loading ? (
        spinner
      ) : (
        children
      )
    ) : (
      <>
        {loading ? spinner : leftIcon}
        <span>{children}</span>
        {!loading && rightIcon}
      </>
    );

    if (renderLink) {
      return <>{renderLink({ className: classes, children: body })}</>;
    }

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={classes}
        {...rest}
      >
        {body}
      </button>
    );
  },
);
