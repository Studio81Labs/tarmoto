import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Button · the "commit" surface. Spec: §17.
 * Three sizes (sm 34 · md 40 · lg 48) × nine variants
 * (primary · accent · secondary · ghost · danger · danger-solid ·
 * success · warning · on-dark).
 * `sm` is 34 px so it lines up with the 34 px form inputs/selects.
 *
 * `danger` is the low-emphasis outline (e.g. a "Delete…" entry point that
 * opens a confirm); `danger-solid` is the filled commit used for the
 * destructive *confirm* itself inside that dialog. Both use the `quality-q1`
 * token; the solid pairs it with `text-ink` (≈4.5:1, matching the brand's
 * ink-on-warm CTAs) rather than cream (which fails AA on `sm`).
 *
 * `success` (a positive commit — Accept an invite, an "Added" done-state) and
 * `warning` (a cautionary action — "Cancel subscription") reuse the quality ramp
 * the same way: `q5` (emerald) and `q2` (amber), each paired with `text-ink`.
 * They are **solid only** — those stops are light, so, unlike `danger`, they
 * meet AA as a *background* with ink text, not as outline text on cream. So
 * there is deliberately no `success`/`warning` outline; for a low-emphasis entry
 * point use `secondary`/`ghost`.
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
  | "success"
  | "warning"
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
  /**
   * Collapse to an icon-only control below `lg`: the label is hidden but kept
   * for screen readers (`sr-only`) and the control goes square, expanding to
   * icon + label at `lg` and up. For header action rows that must stay on one
   * line on tablet/compact viewports. Pair with `leftIcon`/`rightIcon` — the
   * glyph stays visible and the label text remains the accessible name, so no
   * separate `aria-label` is needed.
   */
  collapseLabel?: boolean;
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

// `collapseLabel` renders as a square (iconSizeClass) below `lg`; at `lg`+ it
// drops the fixed width and re-applies each size's labeled horizontal padding.
const collapseLabelLgClass: Record<ButtonSize, string> = {
  sm: "lg:w-auto lg:px-3.5",
  md: "lg:w-auto lg:px-[18px]",
  lg: "lg:w-auto lg:px-[22px]",
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
  success:
    "bg-quality-q5 text-ink border-transparent hover:brightness-95 disabled:hover:brightness-100",
  warning:
    "bg-quality-q2 text-ink border-transparent hover:brightness-95 disabled:hover:brightness-100",
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
      collapseLabel = false,
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
      iconOnly
        ? iconSizeClass[size]
        : collapseLabel
          ? cn(iconSizeClass[size], collapseLabelLgClass[size])
          : sizeClass[size],
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
        {/* `sr-only` (not `hidden`) below lg so the collapsed label stays the
            button's accessible name; `not-sr-only` restores it in-flow at lg.
            `not-sr-only` also resets white-space to normal, so re-assert
            nowrap at lg or a two-word label (e.g. "Save route") can wrap and
            clip inside the fixed-height button. */}
        <span
          className={
            collapseLabel
              ? "sr-only lg:not-sr-only lg:whitespace-nowrap"
              : undefined
          }
        >
          {children}
        </span>
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
