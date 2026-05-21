import type { ReactNode } from "react";

/**
 * Section chrome that mirrors the `.sec-head` block in the Web App v2
 * Design Map: a 240 px left column with a stamped section number and
 * serif title, plus a 70-ch right rail of body copy.
 */
export interface SectionProps {
  id: string;
  num: string;
  title: ReactNode;
  intro: ReactNode;
  tone?: "default" | "tinted" | "dark";
  children: ReactNode;
}

const toneClass: Record<NonNullable<SectionProps["tone"]>, string> = {
  default: "bg-cream text-ink border-line",
  tinted: "bg-paper text-ink border-line",
  dark: "bg-ink text-cream border-ink",
};

export function Section({
  id,
  num,
  title,
  intro,
  tone = "default",
  children,
}: SectionProps) {
  const dark = tone === "dark";
  return (
    <section
      id={id}
      className={`section-anchor border-b px-[60px] py-16 ${toneClass[tone]}`}
    >
      <div className="mb-10 grid grid-cols-[240px_1fr] items-start gap-10">
        <div>
          <div
            className={`font-mono text-[11px] font-bold uppercase tracking-[1.6px] ${dark ? "text-fg-on-dark-dim" : "text-fg-mute"} mb-2`}
          >
            {num}
          </div>
          <h2
            className={`font-serif text-[36px] font-bold leading-none tracking-[-1px] ${dark ? "text-cream" : "text-ink"}`}
          >
            {title}
          </h2>
        </div>
        <div
          className={`max-w-[70ch] pt-4 text-[15px] leading-[1.55] ${dark ? "text-fg-on-dark-dim" : "text-fg-dim"}`}
        >
          {intro}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Small label that sits above a sub-block (mirrors `.stamp` from the design). */
export function SubStamp({
  children,
  onDark = false,
}: {
  children: ReactNode;
  onDark?: boolean;
}) {
  return (
    <div
      className={`mb-3 font-mono text-[11px] font-bold uppercase tracking-[1.6px] ${onDark ? "text-fg-on-dark-dim" : "text-fg-dim"}`}
    >
      {children}
    </div>
  );
}
