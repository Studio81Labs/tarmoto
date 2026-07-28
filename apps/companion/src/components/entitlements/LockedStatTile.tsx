"use client";
import { Lock } from "lucide-react";
import { MetricTile } from "@tarmoto/ui";
import { useTranslation } from "@/i18n/I18nProvider";
import { tierLabel } from "@/lib/entitlements";

/**
 * Locked teaser variant of a KPI `MetricTile` for a Pro-only stat (max lean,
 * ascent) the rider's plan hasn't unlocked — a lock glyph + "Pro" badge in
 * place of the (backend-nulled) real value, so the tile never renders as a
 * blank gap. Used both when the entitlement resolved off AND while it's
 * still unresolved (fail-closed) — callers pass the same `locked` condition
 * that covers both cases.
 */
export function LockedStatTile({ label }: { label: string }) {
  const t = useTranslation();
  return (
    <MetricTile
      label={label}
      value={
        <span className="inline-flex items-center justify-center">
          <Lock size={20} aria-hidden />
          <span className="sr-only">
            {t("Upgrade to Pro to see this stat.")}
          </span>
        </span>
      }
      delta={
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-fg-mute">
          {t(tierLabel("pro"))}
        </span>
      }
    />
  );
}
