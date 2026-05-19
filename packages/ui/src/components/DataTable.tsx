import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * DataTable · the Ride History pattern. Spec: §15.
 * Paper-tinted sticky header in uppercase mono, cream body rows with
 * hairline dividers, mono cells for numerics. Click a row to inspect.
 *
 * This is a thin presentational table — consumers wire data + the row
 * renderer. For data grids with sorting, filtering, virtualisation,
 * etc., extend at the call site.
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
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  showCaret = true,
  className,
}: DataTableProps<T>) {
  const gridTemplate = [
    ...columns.map((c) => c.size ?? "1fr"),
    showCaret ? "40px" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[14px] border border-line bg-cream font-sans",
        className,
      )}
      role="table"
    >
      <div
        role="row"
        className="grid items-center border-b border-line bg-paper px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-mute"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((col) => (
          <span
            key={col.key}
            role="columnheader"
            className={col.align === "right" ? "text-right" : undefined}
          >
            {col.label}
          </span>
        ))}
        {showCaret && <span />}
      </div>

      {rows.map((row, idx) => (
        <div
          key={rowKey(row, idx)}
          role="row"
          tabIndex={onRowClick ? 0 : undefined}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          onKeyDown={
            onRowClick
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }
              : undefined
          }
          className={cn(
            "grid items-center border-b border-line px-5 py-3.5 text-[13px]",
            "last:border-b-0",
            onRowClick && "cursor-pointer",
          )}
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {columns.map((col) => {
            const value = col.render
              ? col.render(row)
              : ((row as Record<string, unknown>)[col.key] as ReactNode);
            return (
              <span
                key={col.key}
                role="cell"
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
            <span role="cell" className="text-fg-mute" aria-hidden="true">
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
