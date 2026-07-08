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
 * sibling regardless of the host page's z-index topology. The bubble is
 * clamped to the viewport so edge triggers (a leftmost back button, a
 * rightmost destructive control) don't render their label off-screen;
 * the tail tracks the trigger centre within the clamped bubble.
 */
export type TooltipPlacement = "above" | "below" | "left" | "right";
export type TooltipKind = "label" | "data" | "coach";

// Gap between the trigger edge and the bubble, matching the 8 px tail.
const GAP_PX = 8;
// Keep the bubble at least this far from the viewport edges when clamping.
const VIEWPORT_MARGIN_PX = 8;
// Half the 8 px tail — keeps the tail fully on the bubble face after clamp.
const TAIL_INSET_PX = 8;

const kindClass: Record<TooltipKind, string> = {
  label: "px-2.5 py-1.5 text-[12px] font-semibold rounded-md whitespace-nowrap",
  data: "px-3 py-2.5 text-[12px] rounded-lg max-w-[220px]",
  coach:
    "px-3.5 py-3 text-[12px] rounded-[10px] max-w-[280px] shadow-[0_24px_60px_rgba(14,14,16,0.4)]",
};

interface BubblePosition {
  top: number;
  left: number;
  /** Inline style for the tail square (position + rotate). */
  tail: CSSProperties;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Resolve the bubble's fixed-position top-left and the tail offset from
 * the trigger rect and the (already-rendered) bubble size, clamping the
 * bubble into the viewport. `getBoundingClientRect` is viewport-relative,
 * so its values map straight onto `position: fixed`.
 */
function computePosition(
  trigger: DOMRect,
  bubbleWidth: number,
  bubbleHeight: number,
  placement: TooltipPlacement,
  viewportWidth: number,
  viewportHeight: number,
): BubblePosition {
  const centerX = trigger.left + trigger.width / 2;
  const centerY = trigger.top + trigger.height / 2;

  if (placement === "left" || placement === "right") {
    const left =
      placement === "right"
        ? trigger.right + GAP_PX
        : trigger.left - GAP_PX - bubbleWidth;
    const top = clamp(
      centerY - bubbleHeight / 2,
      VIEWPORT_MARGIN_PX,
      Math.max(
        VIEWPORT_MARGIN_PX,
        viewportHeight - bubbleHeight - VIEWPORT_MARGIN_PX,
      ),
    );
    const tailTop = clamp(
      centerY - top,
      TAIL_INSET_PX,
      Math.max(TAIL_INSET_PX, bubbleHeight - TAIL_INSET_PX),
    );
    return {
      top,
      left,
      tail: {
        top: tailTop,
        [placement === "right" ? "left" : "right"]: -4,
        transform: "translateY(-50%) rotate(45deg)",
      },
    };
  }

  const top =
    placement === "below"
      ? trigger.bottom + GAP_PX
      : trigger.top - GAP_PX - bubbleHeight;
  const left = clamp(
    centerX - bubbleWidth / 2,
    VIEWPORT_MARGIN_PX,
    Math.max(
      VIEWPORT_MARGIN_PX,
      viewportWidth - bubbleWidth - VIEWPORT_MARGIN_PX,
    ),
  );
  const tailLeft = clamp(
    centerX - left,
    TAIL_INSET_PX,
    Math.max(TAIL_INSET_PX, bubbleWidth - TAIL_INSET_PX),
  );
  return {
    top,
    left,
    tail: {
      left: tailLeft,
      [placement === "below" ? "top" : "bottom"]: -4,
      transform: "translateX(-50%) rotate(45deg)",
    },
  };
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
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<BubblePosition | null>(null);
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
    const triggerEl = triggerRef.current;
    const bubbleEl = bubbleRef.current;
    if (!triggerEl || !bubbleEl) return;
    setPosition(
      computePosition(
        triggerEl.getBoundingClientRect(),
        bubbleEl.offsetWidth,
        bubbleEl.offsetHeight,
        placement,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [placement]);

  // Pin the bubble to the trigger while it's visible. Measuring in a
  // layout effect keeps the position resolved before the browser paints
  // (no flash at 0,0), and the scroll/resize listeners follow a trigger
  // that moves under the fixed-position bubble. `mounted` is a dependency
  // so a force-open (`open`) tooltip re-measures once the portalled bubble
  // exists — the first pass runs before mount, when `bubbleRef` is null.
  // A ResizeObserver re-centres the bubble when its own content changes
  // size while open (e.g. a label swapped for a longer error message),
  // which the trigger-only scroll/resize listeners wouldn't catch.
  useLayoutEffect(() => {
    if (!visible || !mounted) return;
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (observer && bubbleRef.current) observer.observe(bubbleRef.current);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [visible, mounted, measure]);

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

  const bubble = (
    <span
      ref={bubbleRef}
      id={id}
      role="tooltip"
      aria-hidden={!visible}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
      className={cn(
        // Sit above map/header chrome (map overlays top out at z-30) but
        // below modal overlays (dialogs are z-40/z-50), so a tooltip left
        // open by a focused trigger can't paint over a dialog it launched.
        "pointer-events-none fixed z-[35] bg-ink text-cream font-sans",
        "shadow-[0_8px_24px_rgba(14,14,16,0.2)] transition-opacity duration-150",
        visible ? "opacity-100 delay-200" : "opacity-0",
        kindClass[kind],
      )}
    >
      {content}
      <span
        aria-hidden="true"
        style={position?.tail}
        className="absolute size-2 bg-ink"
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
