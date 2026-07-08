import {
  cloneElement,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
 *
 * The bubble is portalled to `document.body` and positioned `fixed`
 * against the trigger's viewport rect. Rendering outside the trigger's
 * DOM subtree is deliberate: header/toolbar chrome frequently sits in a
 * lower stacking context (or clips overflow) than an adjacent map or
 * canvas, which would otherwise paint over an in-flow tooltip. Escaping
 * to the body layer means the bubble is never covered or clipped by a
 * sibling regardless of the host page's z-index topology.
 */
export type TooltipPlacement = "above" | "below" | "left" | "right";
export type TooltipKind = "label" | "data" | "coach";

// Gap between the trigger edge and the bubble, matching the 8 px tail.
const GAP_PX = 8;

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

interface BubbleCoords {
  top: number;
  left: number;
  transform: string;
}

/**
 * Fixed-position coordinates + centring transform for the bubble, from
 * the trigger's viewport rect. `getBoundingClientRect` is already
 * viewport-relative, so it maps straight onto `position: fixed`.
 */
function bubbleCoords(
  rect: DOMRect,
  placement: TooltipPlacement,
): BubbleCoords {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  switch (placement) {
    case "below":
      return {
        top: rect.bottom + GAP_PX,
        left: centerX,
        transform: "translate(-50%, 0)",
      };
    case "left":
      return {
        top: centerY,
        left: rect.left - GAP_PX,
        transform: "translate(-100%, -50%)",
      };
    case "right":
      return {
        top: centerY,
        left: rect.right + GAP_PX,
        transform: "translate(0, -50%)",
      };
    case "above":
    default:
      return {
        top: rect.top - GAP_PX,
        left: centerX,
        transform: "translate(-50%, -100%)",
      };
  }
}

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
  /**
   * Force the tooltip open regardless of hover/focus (for coach marks
   * and controlled demos). This is a *force-open* flag — `false` does
   * not force the tooltip closed; hover/focus still drives visibility
   * when `open` is `false` or `undefined`. To actively suppress a
   * tooltip, omit the component entirely.
   */
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
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<BubbleCoords | null>(null);
  // `open` is a *force-open* flag, never a force-close. When `open` is
  // truthy, the tooltip is visible regardless of hover/focus; when
  // `false` or `undefined`, hover/focus still drives visibility. This
  // matches the prop docs and avoids regressing common coach-mark
  // flows that toggle `open` from `true` to `false`.
  const visible = open === true || hovered || focused;

  // Portalling needs a DOM target — only render the bubble once we're
  // mounted in the browser so SSR emits just the trigger.
  useEffect(() => setMounted(true), []);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(bubbleCoords(el.getBoundingClientRect(), placement));
  }, [placement]);

  // Pin the bubble to the trigger while it's visible. Measuring in a
  // layout effect keeps the position resolved before the browser paints
  // (no flash at 0,0), and the scroll/resize listeners follow a trigger
  // that moves under the fixed-position bubble.
  useLayoutEffect(() => {
    if (!visible) return;
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [visible, measure]);

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
  // Falls back gracefully when children isn't a single DOM-bearing
  // element. Excludes fragments specifically because they pass
  // `isValidElement` but can't carry `aria-describedby` (cloneElement
  // would forward the prop to a synthetic node and React warns in
  // development). Same for null, text, conditional expressions like
  // `isReady && <button />` — the wrapper still renders, just
  // without the AT binding on the trigger.
  const isCloneable =
    isValidElement(children) && (children as ReactElement).type !== Fragment;
  const triggerWithAria = isCloneable
    ? cloneElement(children as ReactElement<HTMLAttributes<HTMLElement>>, {
        "aria-describedby": mergeDescribedBy(
          (children as ReactElement<HTMLAttributes<HTMLElement>>).props[
            "aria-describedby"
          ],
          id,
        ),
      })
    : children;

  const bubbleStyle: CSSProperties = {
    top: coords?.top ?? 0,
    left: coords?.left ?? 0,
    transform: coords?.transform,
  };

  const bubble = (
    <span
      id={id}
      role="tooltip"
      aria-hidden={!visible}
      style={bubbleStyle}
      className={cn(
        "pointer-events-none fixed z-[100] bg-ink text-cream font-sans",
        "shadow-[0_8px_24px_rgba(14,14,16,0.2)] transition-opacity duration-150",
        visible ? "opacity-100 delay-200" : "opacity-0",
        kindClass[kind],
      )}
    >
      {content}
      <span
        aria-hidden="true"
        className={cn("absolute size-2 rotate-45 bg-ink", tailClass[placement])}
      />
    </span>
  );

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={handleKeyDown}
    >
      {triggerWithAria}
      {mounted ? createPortal(bubble, document.body) : null}
    </span>
  );
}
