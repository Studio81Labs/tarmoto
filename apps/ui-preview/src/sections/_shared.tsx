import type { ReactNode } from "react";

/**
 * Shared section primitives used across the design-map preview.
 *
 * - `TokenTable` mirrors the `.tokens` grid in the source HTML — a
 *   paper-tinted header row + striped body rows in a CSS grid.
 * - `DoDontGrid` mirrors the `.rule` block — colored DO / DON'T pill
 *   plus a heading + body copy.
 * - `CodeBlock` mirrors the `pre.code` block — JetBrains Mono on ink
 *   fill, with light syntax-style spans.
 * - `SubStampOnLight` is a small mono caption with a known colour.
 */

export interface TokenTableColumn {
  label: string;
  size?: string;
  align?: "left" | "right";
}

export interface TokenTableProps {
  columns: ReadonlyArray<TokenTableColumn>;
  /** Each row: list of cells matching columns. */
  rows: ReadonlyArray<ReactNode[]>;
  className?: string;
}

export function TokenTable({ columns, rows, className }: TokenTableProps) {
  const cols = columns.map((c) => c.size ?? "1fr").join(" ");
  return (
    <div
      className={`overflow-hidden rounded-[10px] border border-line bg-cream ${className ?? ""}`}
    >
      <div
        className="grid items-center gap-3 border-b border-line bg-paper px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[1.2px] text-fg-dim"
        style={{ gridTemplateColumns: cols }}
      >
        {columns.map((c) => (
          <span
            key={c.label}
            className={c.align === "right" ? "text-right" : undefined}
          >
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((cells, i) => (
        <div
          key={i}
          className="grid items-center gap-3 border-b border-line px-4 py-2.5 text-[12.5px] last:border-b-0"
          style={{ gridTemplateColumns: cols }}
        >
          {cells.map((cell, j) => (
            <span
              key={j}
              className={columns[j]?.align === "right" ? "text-right" : ""}
            >
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- Do / Don't / Tip rules ---------- */

export type RuleKind = "do" | "dont" | "tip";

export interface RuleRow {
  kind: RuleKind;
  title: ReactNode;
  body: ReactNode;
}

export function DoDontGrid({
  left,
  right,
  className,
}: {
  left: ReadonlyArray<RuleRow>;
  right: ReadonlyArray<RuleRow>;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-2 gap-6 ${className ?? ""}`}>
      <div className="flex flex-col">
        {left.map((r, i) => (
          <Rule key={i} {...r} />
        ))}
      </div>
      <div className="flex flex-col">
        {right.map((r, i) => (
          <Rule key={i} {...r} />
        ))}
      </div>
    </div>
  );
}

const badgeClass: Record<RuleKind, string> = {
  do: "bg-quality-q5 text-ink",
  dont: "bg-quality-q1 text-cream",
  tip: "bg-ink text-cream",
};

const badgeLabel: Record<RuleKind, string> = {
  do: "Do",
  dont: "Don't",
  tip: "Tip",
};

export function Rule({ kind, title, body }: RuleRow) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-start gap-4 border-b border-line py-4 last:border-b-0">
      <div
        className={`rounded p-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-[1.4px] ${badgeClass[kind]}`}
      >
        {badgeLabel[kind]}
      </div>
      <div>
        <div className="mb-1 text-[14px] font-bold">{title}</div>
        <div className="text-[13px] leading-[1.55] text-fg-dim">{body}</div>
      </div>
    </div>
  );
}

/* ---------- Code block ---------- */

export function CodeBlock({
  children,
  className,
  tone = "ink",
}: {
  children: ReactNode;
  className?: string;
  tone?: "ink" | "tarmac";
}) {
  return (
    <pre
      className={`m-0 overflow-x-auto rounded-[10px] p-4 font-mono text-[11px] leading-[1.65] text-cream ${
        tone === "tarmac" ? "bg-tarmac" : "bg-ink"
      } ${className ?? ""}`}
    >
      {children}
    </pre>
  );
}

/* Light-coloured spans used inside code blocks. */
export function CK({ children }: { children: ReactNode }) {
  return <span className="text-[#9CDCFE]">{children}</span>;
}
export function CN({ children }: { children: ReactNode }) {
  return <span className="text-[#B5CEA8]">{children}</span>;
}
export function CS({ children }: { children: ReactNode }) {
  return <span className="text-[#CE9178]">{children}</span>;
}
export function CC({ children }: { children: ReactNode }) {
  return <span className="text-cream/55">{children}</span>;
}

/* ---------- Coloured dot inline (used in tables) ---------- */

export function ColorDot({
  color,
  size = 14,
}: {
  color: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full"
      style={{ width: size, height: size, background: color }}
    />
  );
}
