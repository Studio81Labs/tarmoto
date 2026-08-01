import type { ReactNode } from "react";

/**
 * Section title for a table, rendered in the DataTable's own `header` slot.
 * A DataTable is already a bordered card, so wrapping one in a second card
 * just to hold a heading double-frames the section — the header slot keeps
 * the title bound to its table with a single frame.
 *
 * `px-5` matches the DataTable's own cell gutter.
 */
export function TableHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-5 py-3 text-sm font-semibold text-ink">{children}</h3>
  );
}
