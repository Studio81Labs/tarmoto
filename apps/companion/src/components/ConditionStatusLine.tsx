import type { ReactNode } from "react";

/**
 * The single status line each CONDITIONS section shows (revision 6).
 * `clear` is the earned green all-clear; `no_data` is the neutral grey
 * unknown — same visual vocabulary as the pass legend's Open/Unknown
 * dots, so "we don't know" never masquerades as "you're safe".
 */
export function ConditionStatusLine({
  tone,
  children,
}: {
  tone: "clear" | "no_data";
  children: ReactNode;
}) {
  return (
    <p
      className={`flex items-center gap-1.5 text-xs ${
        tone === "clear" ? "text-[#1f8a5b]" : "text-fg-mute"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          tone === "clear" ? "bg-[#1f8a5b]" : "bg-ink/40"
        }`}
      />
      {children}
    </p>
  );
}
