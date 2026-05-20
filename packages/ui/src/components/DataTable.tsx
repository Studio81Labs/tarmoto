import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * DataTable · the Ride History pattern. Spec: §15.
 * Paper-tinted sticky header in uppercase mono, cream body rows with
 * hairline dividers, mono cells for numerics. Click a row to inspect.
 *
 * This is a thin presentational table — consumers wire data + the row
 * renderer. For data grids with sorting, filtering, virtualisation,
 * etc., extend at the call site.
 *
 * **A11y semantics flip with interactivity.** When `onRowClick` is set,
 * the outer container takes `role="grid"` (interactive grid) and cells
 * become `role="gridcell"` so AT correctly announces rows as
 * activatable. Without `onRowClick`, the static `role="table"` /
 * `role="cell"` pair is used. Rows in the interactive mode are
 * keyboard-focusable and respond to Enter / Space.
 */
export interface DataTableColumn<T> {
  key: string;
  label: string;
  /** CSS grid column size — e.g. "80px", "1fr", "90px". */
  size?: string;
  /** Render the cell. The default renders `row[key]` as plain text. */
  render?: (row: T) => ReactNode;
  /** Mono numeric cell. */
  numeric?: boolean;
  /** Right-align the cell. */
  align?: "left" | "right";
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Render a chevron column at the end. Default: true. */
  showCaret?: boolean;
  className?: string;
  /** Optional accessible label for the table/grid. */
  ariaLabel?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  showCaret = true,
  className,
  ariaLabel,
}: DataTableProps<T>) {
  const gridTemplate = [
    ...columns.map((c) => c.size ?? "1fr"),
    showCaret ? "40px" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const interactive = Boolean(onRowClick);
  const tableRole = interactive ? "grid" : "table";
  const cellRole = interactive ? "gridcell" : "cell";
  const totalCols = columns.length + (showCaret ? 1 : 0);
  // Header is row 1; body rows start at 2.
  const headerRowIndex = 1;

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: T) => {
    if (!onRowClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[14px] border border-line bg-cream font-sans",
        className,
      )}
      role={tableRole}
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      aria-colcount={totalCols}
    >
      <div
        role="row"
        aria-rowindex={headerRowIndex}
        className="grid items-center border-b border-line bg-paper px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-mute"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((col, i) => (
          <span
            key={col.key}
            role="columnheader"
            aria-colindex={i + 1}
            className={col.align === "right" ? "text-right" : undefined}
          >
            {col.label}
          </span>
        ))}
        {showCaret && <span role="columnheader" aria-colindex={totalCols} />}
      </div>

      {rows.map((row, idx) => (
        <div
          key={rowKey(row, idx)}
          role="row"
          aria-rowindex={idx + 2}
          tabIndex={interactive ? 0 : undefined}
          onClick={interactive ? () => onRowClick?.(row) : undefined}
          onKeyDown={interactive ? (e) => handleRowKeyDown(e, row) : undefined}
          className={cn(
            "grid items-center border-b border-line px-5 py-3.5 text-[13px]",
            "last:border-b-0",
            interactive &&
              "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
          )}
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {columns.map((col, i) => {
            const value = col.render
              ? col.render(row)
              : ((row as Record<string, unknown>)[col.key] as ReactNode);
            return (
              <span
                key={col.key}
                role={cellRole}
                aria-colindex={i + 1}
                className={cn(
                  col.numeric && "font-mono tabular-nums",
                  col.align === "right" && "text-right",
                )}
              >
                {value}
              </span>
            );
          })}
          {showCaret && (
            <span
              role={cellRole}
              aria-colindex={totalCols}
              className="text-fg-mute"
              aria-hidden="true"
            >
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
