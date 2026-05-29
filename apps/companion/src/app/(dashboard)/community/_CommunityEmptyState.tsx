import type { ReactNode } from "react";

/**
 * Spec-aligned empty-state card shared by `/community/feed` and
 * `/community/collections`. Spec: v2-pages.jsx CommunityView — 56 ×
 * 56 paper-coloured icon ring, 18 px 800 title, 13 px fg-dim body
 * capped at 480 px.
 *
 * Each page passes a different glyph + copy:
 * - `/community/feed`        — Users  · "Quiet on the feed"
 * - `/community/collections` — Folder · "No collections yet"
 */
export function CommunityEmptyState({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-cream px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-paper text-fg-mute">
        {icon}
      </div>
      <div className="text-[18px] font-extrabold text-ink">{title}</div>
      <div className="max-w-[480px] text-[13px] leading-[1.55] text-fg-dim">
        {body}
      </div>
    </div>
  );
}
