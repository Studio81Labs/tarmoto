import { Button } from "@tarmoto/ui";

interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  /** Total row count across all pages, shown alongside the page position. */
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * The console's only page navigator: "Page X of Y (N total)" on the left,
 * Prev / Next on the right. Prev/Next auto-disable at the ends and the step
 * is clamped, so a caller cannot land on page 0 or past the last page.
 *
 * Rendered in the DataTable's `footer` slot (the companion's RidesTable does
 * the same), which spans every column inside the table card — hence the
 * built-in `px-5 py-3`, matching the table's own cell gutter. The row stays
 * visible on a single page because the total is useful on its own.
 */
export function Pagination({
  page,
  pageCount,
  total,
  onPageChange,
  className,
}: PaginationProps) {
  return (
    <div
      className={[
        "flex items-center justify-between gap-3 px-5 py-3 text-sm text-fg-dim",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span>
        Page {page} of {pageCount} ({total} total)
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
