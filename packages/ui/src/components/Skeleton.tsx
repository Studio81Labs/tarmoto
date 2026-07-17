import { cn } from "../utils/cn";

/**
 * Loading vocabulary (v2-loading spec): a shimmering `Skeleton` block, a
 * 3px indeterminate `PageLoadingBar`, and layout compositions matching the
 * spec's archetypes — page header, list rows, card grid, dashboard. Pair
 * with `useDelayedLoading`-style gating so fast responses never flash them.
 */

/** Shimmer block · size/shape via className (spec default radius 7px). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "shrink-0 animate-skeleton rounded-[7px] motion-reduce:animate-none",
        "bg-[linear-gradient(90deg,rgba(14,14,16,0.055)_25%,rgba(14,14,16,0.11)_50%,rgba(14,14,16,0.055)_75%)]",
        "bg-[length:200%_100%] motion-reduce:bg-ink/[0.08]",
        className,
      )}
    />
  );
}

/**
 * Indeterminate top progress bar: a 30%-wide accent segment sweeping a 3px
 * ink track. Absolutely positioned — give the parent `relative`.
 */
export function PageLoadingBar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px] overflow-hidden bg-ink/[0.06]",
        className,
      )}
    >
      {/* Reduced motion: no animation at all — the segment rests statically
          at the track's left edge, still reading as "in progress". */}
      <div className="absolute inset-y-0 w-[30%] animate-loading-bar rounded-[3px] bg-accent motion-reduce:animate-none" />
    </div>
  );
}

/** Screen-reader announcement shared by the layout compositions. */
function LoadingStatus({ label }: { label: string }) {
  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  );
}

/** Page-header placeholder: stamp, title, sub + two action blocks. */
export function SkeletonPageHeader({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("mb-6 flex items-start justify-between gap-5", className)}
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-[9px] w-[70px] rounded-[4px]" />
        <Skeleton className="h-[26px] w-[220px] rounded-lg" />
        <Skeleton className="h-3 w-[260px]" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-[38px] w-[104px] rounded-[10px]" />
        <Skeleton className="h-[38px] w-11 rounded-[10px]" />
      </div>
    </div>
  );
}

/** One list-archetype row: thumb · title/sub/pills · trailing stat. */
export function SkeletonListRow() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-4 rounded-[14px] border border-line bg-paper-2 p-3.5"
    >
      <Skeleton className="h-[72px] w-[92px] rounded-[10px]" />
      <div className="flex flex-1 flex-col gap-2.5">
        <Skeleton className="h-[15px] w-[46%]" />
        <Skeleton className="h-[11px] w-[72%]" />
        <div className="mt-0.5 flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-[52px] rounded-full" />
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <Skeleton className="h-5 w-[54px]" />
        <Skeleton className="h-[9px] w-10" />
      </div>
    </div>
  );
}

/** List archetype (rides / trips / feed): stacked thumb rows. */
export function SkeletonList({
  rows = 4,
  label = "Loading…",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <LoadingStatus label={label} />
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonListRow key={index} />
      ))}
    </div>
  );
}

/** One grid-archetype card: image block over title/sub/pills. */
export function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[14px] border border-line bg-paper-2"
    >
      <Skeleton className="h-[124px] w-full rounded-none" />
      <div className="flex flex-col gap-2.5 p-3.5">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-2.5 w-full" />
        <div className="mt-0.5 flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-11 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/** Grid archetype (community / collections): responsive card grid. */
export function SkeletonGrid({
  cards = 6,
  label = "Loading…",
  className,
}: {
  cards?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      <LoadingStatus label={label} />
      {Array.from({ length: cards }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}

/** Dashboard archetype (home / stats / detail): KPI row + chart cards. */
export function SkeletonDashboard({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-[18px]", className)}>
      <LoadingStatus label={label} />
      <div
        aria-hidden="true"
        className="grid grid-cols-2 gap-[14px] lg:grid-cols-4"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-paper-2 p-4"
          >
            <Skeleton className="h-[9px] w-[60px] rounded-[4px]" />
            <Skeleton className="h-6 w-3/4 rounded-lg" />
            <Skeleton className="h-[9px] w-1/2" />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="rounded-[14px] border border-line bg-paper-2 p-5"
      >
        <Skeleton className="mb-4 h-[9px] w-[120px] rounded-[4px]" />
        <Skeleton className="h-[90px] w-full rounded-[10px]" />
      </div>
      <div aria-hidden="true" className="grid gap-[18px] lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div
            key={index}
            className="rounded-[14px] border border-line bg-paper-2 p-5"
          >
            <Skeleton className="mb-4 h-[9px] w-[100px] rounded-[4px]" />
            <Skeleton className="h-[80px] w-full rounded-[10px]" />
          </div>
        ))}
      </div>
    </div>
  );
}
