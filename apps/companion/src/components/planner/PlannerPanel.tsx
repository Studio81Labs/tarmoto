"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useFormat } from "@/format/FormatProvider";
import type { ReactNode } from "react";
import { Heading, Stamp } from "@tarmoto/ui";

/**
 * "Plan & inspect" panel shell — the planner's right column per the
 * Web App v2 (Full) design. Owns the header and the mono tab bar;
 * tab content is passed in so the page keeps owning planner state.
 */
export const PLANNER_TABS = [
  "BUILD",
  "INSPECT",
  "CONDITIONS",
  "STOPS",
] as const;
export type PlannerTab = (typeof PLANNER_TABS)[number];

interface PlannerPanelProps {
  tab: PlannerTab;
  onTabChange: (tab: PlannerTab) => void;
  build: ReactNode;
  inspect: ReactNode;
  conditions: ReactNode;
  stops: ReactNode;
}

export function PlannerPanel({
  tab,
  onTabChange,
  build,
  inspect,
  conditions,
  stops,
}: PlannerPanelProps) {
  const t = useTranslation();
  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-paper">
      <div className="shrink-0 px-5 pt-4">
        <Stamp>{t("Route planner")}</Stamp>
        <Heading size="md" as="h2" className="mt-1.5 text-[20px]">
          {t("Plan & inspect")}
        </Heading>
        <p className="mt-1 text-[12px] leading-snug text-fg-dim">
          {t(
            "Crowdsourced road quality on every metre — no Street View detours.",
          )}
        </p>
        <div
          role="tablist"
          aria-label={t("Planner sections")}
          className="mt-4 flex gap-0.5 border-b border-line"
        >
          {PLANNER_TABS.map((name) => {
            const active = tab === name;
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(name)}
                className={`relative flex-1 pb-2.5 text-center font-mono text-[10.5px] font-bold tracking-[0.3px] transition ${
                  active ? "text-accent" : "text-fg-mute hover:text-ink"
                }`}
              >
                {name}
                {active ? (
                  <span className="absolute -bottom-px left-1.5 right-1.5 h-0.5 rounded bg-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Every pane stays mounted (hidden when inactive) so tab switches
          don't drop in-progress state — month picker, stop filters, drag
          state — and panel-hosted data hooks keep their results. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-9 pt-5">
        <div hidden={tab !== "BUILD"}>{build}</div>
        <div hidden={tab !== "INSPECT"}>{inspect}</div>
        <div hidden={tab !== "CONDITIONS"}>{conditions}</div>
        <div hidden={tab !== "STOPS"}>{stops}</div>
      </div>
    </aside>
  );
}

/** `§ NN LABEL` section stamp used across the panel tabs (design frames). */
export function SectionStamp({
  n,
  children,
}: {
  n: number;
  children: ReactNode;
}) {
  const t = useTranslation();
  const format = useFormat();
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="font-mono text-[10px] font-bold tracking-[1px] text-accent">
        {t("§ {number}", {
          number: format.number(n, {
            useGrouping: false,
            minimumIntegerDigits: 2,
            maximumFractionDigits: 0,
          }),
        })}
      </span>
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1.4px] text-fg-mute">
        {children}
      </span>
    </div>
  );
}
