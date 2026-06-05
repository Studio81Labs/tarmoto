import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * DataTable · the Ride History pattern. Spec: §15.
 * Paper-tinted header in uppercase mono, cream body rows with hairline
 * dividers, mono cells for numerics. Renders a real semantic `<table>`
 * (`<thead>`/`<tbody>`/`<tfoot>`, `<th scope>`, `<td>`) so assistive tech and
 * the browser get genuine tabular structure — not ARIA roles bolted onto divs.
 *
 * Column widths come from `<colgroup>` + `table-fixed`; give fixed columns a
 * px `size` and leave the flexible column's `size` unset (or "1fr") so it
 * absorbs the remainder.
 *
 * **Row navigation.** Set `getRowHref` to make each row a link. The whole row
 * is clickable via a stretched overlay on the link in the `primary` column,
 * while a single discoverable link stays in the a11y tree. Because `@tarmoto/ui`
 * is framework-agnostic, pass `renderLink` to supply your router's link
 * component (e.g. Next's `<Link>`); it falls back to a plain `<a>`.
 *
 * **Sorting.** Mark columns `sortable` and pass `sort` + `onSort`; sortable
 * headers render as buttons with an asc/desc caret.
 */
export interface DataTableColumn<T> {
  key: string;
  label: ReactNode;
  /** Fixed `<col>` width, e.g. "90px". Omit (or "1fr") for the flex column. */
  size?: string;
  /** Render the cell. Defaults to `row[key]` as plain text. */
  render?: (row: T) => ReactNode;
  /** Mono tabular-nums cell. */
  numeric?: boolean;
  /** Horizontal alignment. */
  align?: "left" | "right";
  /** Header is a sort toggle (needs `sort` + `onSort` on the table). */
  sortable?: boolean;
  /** This column's cell carries the stretched row link. Default: first column. */
  primary?: boolean;
}

export interface DataTableSort {
  key: string;
  direction: "asc" | "desc";
}

export interface RenderLinkProps {
  href: string;
  className: string;
  children: ReactNode;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  /** Make each row a link to this href (client nav via `renderLink`). */
  getRowHref?: (row: T) => string;
  /** Supply the router link component; defaults to a plain `<a>`. */
  renderLink?: (props: RenderLinkProps) => ReactNode;
  /** Non-link interactive rows (Enter/Space/click). Ignored if `getRowHref`. */
  onRowClick?: (row: T) => void;
  sort?: DataTableSort;
  onSort?: (key: string) => void;
  /** Trailing chevron column. Default: true. */
  showCaret?: boolean;
  caret?: ReactNode;
  /** Body shown when `rows` is empty. */
  emptyState?: ReactNode;
  /** Header content (e.g. a title bar) rendered above the column row, inside
   *  the card, with a hairline divider below it. */
  header?: ReactNode;
  /** Footer content (e.g. pagination), spanning all columns in a `<tfoot>`. */
  footer?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  getRowHref,
  renderLink,
  onRowClick,
  sort,
  onSort,
  showCaret = true,
  caret,
  emptyState,
  header,
  footer,
  className,
  ariaLabel,
}: DataTableProps<T>) {
  const totalCols = columns.length + (showCaret ? 1 : 0);
  const linkable = Boolean(getRowHref);
  const clickable = !linkable && Boolean(onRowClick);
  const primaryKey =
    columns.find((c) => c.primary)?.key ?? columns[0]?.key ?? null;

  const renderRowLink = (props: RenderLinkProps): ReactNode =>
    renderLink ? (
      renderLink(props)
    ) : (
      <a href={props.href} className={props.className}>
        {props.children}
      </a>
    );

  const handleRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
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
    >
      {header && <div className="border-b border-line">{header}</div>}
      <table
        className="w-full table-fixed border-collapse"
        aria-label={ariaLabel}
      >
        <colgroup>
          {columns.map((col) => (
            <col
              key={col.key}
              style={
                col.size && !col.size.includes("fr")
                  ? { width: col.size }
                  : undefined
              }
            />
          ))}
          {showCaret && <col style={{ width: "40px" }} />}
        </colgroup>

        <thead>
          <tr className="border-b border-line bg-paper">
            {columns.map((col) => {
              const active = col.sortable && sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={
                    col.sortable
                      ? active
                        ? sort?.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                  className={cn(
                    "px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-mute",
                    col.align === "right" ? "text-right" : "text-left",
                  )}
                >
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className="inline-flex items-center gap-1 uppercase tracking-[1px] transition hover:text-ink"
                    >
                      {col.label}
                      {active && (
                        <span aria-hidden="true">
                          {sort?.direction === "asc" ? "↑" : "↓"}
                        </span>
                      )}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
            {showCaret && <th scope="col" className="px-5 py-2.5" />}
          </tr>
        </thead>

        <tbody>
          {rows.length === 0 && emptyState ? (
            <tr>
              <td colSpan={totalCols} className="px-5 py-10 text-center">
                {emptyState}
              </td>
            </tr>
          ) : (
            rows.map((row, idx) => {
              const href = getRowHref?.(row);
              return (
                <tr
                  key={rowKey(row, idx)}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onRowClick?.(row) : undefined}
                  onKeyDown={
                    clickable ? (e) => handleRowKeyDown(e, row) : undefined
                  }
                  className={cn(
                    "border-b border-line align-middle last:border-b-0",
                    (linkable || clickable) &&
                      "relative transition hover:bg-paper focus-within:bg-paper",
                    clickable &&
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
                  )}
                >
                  {columns.map((col) => {
                    const content = col.render
                      ? col.render(row)
                      : ((row as Record<string, unknown>)[
                          col.key
                        ] as ReactNode);
                    const carriesLink = href != null && col.key === primaryKey;
                    return (
                      <td
                        key={col.key}
                        className={cn(
                          "px-5 py-3 text-[13px]",
                          col.numeric && "font-mono tabular-nums",
                          col.align === "right" && "text-right",
                        )}
                      >
                        {carriesLink
                          ? renderRowLink({
                              href: href as string,
                              className:
                                "rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                              children: content,
                            })
                          : content}
                      </td>
                    );
                  })}
                  {showCaret && (
                    <td className="px-5 py-3 text-right text-fg-mute">
                      <span aria-hidden="true">{caret ?? "→"}</span>
                    </td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>

        {footer && (
          <tfoot>
            <tr>
              <td colSpan={totalCols} className="border-t border-line">
                {footer}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
