import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../utils/cn";

/**
 * Tooltip · explain / reveal / onboard. Spec: §19.
 * Three jobs, one chassis: ink fill, 8 px tail, 200 ms hover delay.
 * Use a popover/alert for content that needs an action.
 *
 * The trigger must be a single React element (button / anchor / input
 * / span etc.) — the tooltip clones it to inject `aria-describedby`
 * pointing at the bubble. That puts the AT relationship on the
 * focusable node itself rather than on the positioning wrapper, so
 * screen readers announce the content when the trigger receives focus.
 */
export type TooltipPlacement = "above" | "below" | "left" | "right";
export type TooltipKind = "label" | "data" | "coach";

const placementClass: Record<TooltipPlacement, string> = {
  above: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  below: "top-full left-1/2 mt-2 -translate-x-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
};

const tailClass: Record<TooltipPlacement, string> = {
  above: "bottom-[-4px] left-1/2 -translate-x-1/2",
  below: "top-[-4px] left-1/2 -translate-x-1/2",
  right: "left-[-4px] top-1/2 -translate-y-1/2",
  left: "right-[-4px] top-1/2 -translate-y-1/2",
};

const kindClass: Record<TooltipKind, string> = {
  label: "px-2.5 py-1.5 text-[12px] font-semibold rounded-md whitespace-nowrap",
  data: "px-3 py-2.5 text-[12px] rounded-lg max-w-[220px]",
  coach:
    "px-3.5 py-3 text-[12px] rounded-[10px] max-w-[280px] shadow-[0_24px_60px_rgba(14,14,16,0.4)]",
};

export interface TooltipProps {
  /**
   * The trigger — must be a single React element so the tooltip can
   * attach `aria-describedby` to it. Wrap non-focusable nodes in a
   * `<span tabIndex={0}>` if you need focus-triggered tooltips on text.
   */
  children: ReactNode;
  /** Tooltip body. */
  content: ReactNode;
  placement?: TooltipPlacement;
  kind?: TooltipKind;
  /** Open without hover/focus (for coach marks). */
  open?: boolean;
  className?: string;
}

/**
 * Merge `aria-describedby` with whatever value the consumer already set
 * on the trigger — space-separated per WAI-ARIA. Avoids clobbering
 * tooltips bound to elements that already point at help text.
 */
function mergeDescribedBy(
  existing: unknown,
  next: string | undefined,
): string | undefined {
  if (!next) {
    return typeof existing === "string" ? existing : undefined;
  }
  if (typeof existing !== "string" || existing.length === 0) return next;
  return existing.includes(next) ? existing : `${existing} ${next}`;
}

export function Tooltip({
  children,
  content,
  placement = "above",
  kind = "label",
  open,
  className,
}: TooltipProps) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visible = open ?? (hovered || focused);

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === "Escape") setFocused(false);
  };

  // Inject `aria-describedby` onto the actual trigger element rather
  // than the positioning wrapper, so screen readers pick it up when
  // focus lands on the trigger.
  //
  // The relationship is *permanent* — bound whether or not `visible`
  // is true — so AT knows about the description at the moment the
  // trigger receives focus, not only after a state toggle. Whether
  // the bubble's content is actually announced is gated by
  // `aria-hidden={!visible}` on the bubble itself.
  //
  // Falls back gracefully when children isn't a single React element
  // (null, text, fragments, conditional expressions like
  // `isReady && <button />`) — the wrapper still renders, just
  // without the AT binding on the trigger.
  const triggerWithAria = isValidElement(children)
    ? cloneElement(children as ReactElement<HTMLAttributes<HTMLElement>>, {
        "aria-describedby": mergeDescribedBy(
          (children as ReactElement<HTMLAttributes<HTMLElement>>).props[
            "aria-describedby"
          ],
          id,
        ),
      })
    : children;

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={handleKeyDown}
    >
      {triggerWithAria}
      <span
        id={id}
        role="tooltip"
        aria-hidden={!visible}
        className={cn(
          "pointer-events-none absolute z-20 bg-ink text-cream font-sans",
          "shadow-[0_8px_24px_rgba(14,14,16,0.2)] transition-opacity duration-150",
          visible ? "opacity-100 delay-200" : "opacity-0",
          placementClass[placement],
          kindClass[kind],
        )}
      >
        {content}
        <span
          aria-hidden="true"
          className={cn(
            "absolute size-2 rotate-45 bg-ink",
            tailClass[placement],
          )}
        />
      </span>
    </span>
  );
}
