"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "@tarmoto/ui";
import { t } from "@/i18n";

/**
 * Shared chrome for every `/settings/*` sub-page. Spec: v2-pages.jsx
 * Settings views — every sub-page leads with a `← Settings` back link,
 * then the unified stamp `Settings · {Subpage}` + 18 px accent glyph +
 * 32 px Space Grotesk 800 title + sub copy. Each page passes its own
 * icon, title, sub, and optional `right` slot (e.g. `Add bike` CTA on
 * the garage page).
 */
export function SettingsSubpageHeader({
  stamp,
  icon,
  title,
  sub,
  right,
}: {
  stamp: string;
  icon: ReactNode;
  title: string;
  sub: string;
  right?: ReactNode;
}) {
  return (
    <>
      <Link
        href="/settings"
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-fg-dim transition hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        {t("Settings")}
      </Link>
      <PageHeader
        stamp={stamp}
        icon={icon}
        title={title}
        sub={sub}
        right={right}
      />
    </>
  );
}
