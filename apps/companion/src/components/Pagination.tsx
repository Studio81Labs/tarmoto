"use client";
import clsx from "clsx";
import { t } from "@/i18n";

interface PaginationProps {
  /** 1-based current page. */
  currentPage: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  onPrevious: () => void;
  onNext: () => void;
  /** Padding/layout for the row wrapper (the consumer owns the surface). */
  className?: string;
}

// Cream pill buttons matching the shared field chrome, so every paged surface
// (ride history table, community feed, …) reads the same. Extracted from the
// community feed's original inline paginator.
const PILL =
  "inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-cream px-3 py-[5px] text-[11px] font-bold uppercase tracking-[0.2px] text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Canonical page navigator: "Page X of Y" on the left, Previous / Next pill
 * buttons on the right. Prev/Next auto-disable at the ends from
 * `currentPage`/`pageCount`; the consumer supplies the step handlers and wraps
 * it in whatever surface fits (a Card, a table footer row, …) via `className`.
 */
export function Pagination({
  currentPage,
  pageCount,
  onPrevious,
  onNext,
  className,
}: PaginationProps) {
  return (
    <div className={clsx("flex items-center justify-between gap-3", className)}>
      <p className="font-mono text-sm tabular-nums text-fg-dim">
        {t("Page {currentPage} of {pageCount}", { currentPage, pageCount })}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrevious}
          disabled={currentPage <= 1}
          aria-label={t("Previous page")}
          className={PILL}
        >
          {t("Previous ")}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={currentPage >= pageCount}
          aria-label={t("Next page")}
          className={PILL}
        >
          {t("Next ")}
        </button>
      </div>
    </div>
  );
}
