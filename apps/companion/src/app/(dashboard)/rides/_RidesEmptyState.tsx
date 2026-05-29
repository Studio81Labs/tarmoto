import type { ReactNode } from "react";

/**
 * Spec-aligned empty-state card shared by all three Ride History
 * pages. Spec: v2-pages.jsx RideHistoryView — 56 × 56 paper-coloured
 * icon ring, 18 px 800 title, 13 px fg-dim body capped at 480 px.
 *
 * Each page passes a different glyph + copy:
 * - `/rides`           — Activity icon  · "No rides recorded yet"
 * - `/rides/road-map`  — Map icon       · "Your road map is empty"
 * - `/rides/compare`   — Scale icon     · "Need two rides to compare"
 */
export function RidesEmptyState({
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
