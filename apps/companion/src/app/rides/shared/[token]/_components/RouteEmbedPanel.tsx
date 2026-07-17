"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Check, Code2, Copy, MousePointerClick, Eye } from "lucide-react";
import { Card, Stamp } from "@tarmoto/ui";
import { useFormat } from "@/format/FormatProvider";
import {
  buildRideIframeCode,
  formatRideEmbedStat,
  type RideWidgetVariant,
} from "@/lib/ride-embed";
interface Props {
  origin: string;
  token: string;
  rideLabel: string;
  views: number;
  clicks: number;
}
const VARIANTS: Array<{
  value: RideWidgetVariant;
  label: string;
  description: string;
}> = [
  {
    value: "compact",
    label: "Compact",
    description: "Best for sidebars and narrower community posts.",
  },
  {
    value: "landscape",
    label: "Landscape",
    description: "Best for blog posts, forums, and full-width sections.",
  },
];
export function RouteEmbedPanel({
  origin,
  token,
  rideLabel,
  views,
  clicks,
}: Props) {
  const format = useFormat();
  const [variant, setVariant] = useState<RideWidgetVariant>("compact");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const snippet = useMemo(
    () => buildRideIframeCode(origin, { token, rideLabel, variant }),
    [origin, token, rideLabel, variant],
  );
  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }
  return (
    <Card className="p-[26px]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-transparent px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.2px] text-accent">
            <Code2 size={13} />
            {t("Embed route")}
          </div>
          <h2 className="mt-3 text-[22px] font-extrabold leading-[1.05] tracking-[-0.5px] text-ink">
            {t("Share this ride as a route widget")}
          </h2>
          <p className="mt-1.5 max-w-[560px] text-[13.5px] leading-[1.55] text-fg-dim">
            {t(
              "Publish a branded ride preview with route stats, Tarmoto attribution, and a link back to the full shared ride page.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-[10px] border border-accent bg-accent px-4 py-[11px] text-[12.5px] font-bold uppercase tracking-[0.4px] text-ink transition hover:bg-accent/90"
        >
          {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
          {t("Copy embed code")}
        </button>
      </div>

      <div className="mt-[18px] flex flex-wrap gap-2">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-cream px-[13px] py-[7px] text-[12.5px] font-semibold text-fg-dim">
          <Eye size={13} className="text-accent" />
          {formatRideEmbedStat(views, "view", format, t)}
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-cream px-[13px] py-[7px] text-[12.5px] font-semibold text-fg-dim">
          <MousePointerClick size={13} className="text-accent" />
          {formatRideEmbedStat(clicks, "click", format, t)}
        </div>
      </div>

      <div className="mt-[18px] grid grid-cols-1 gap-3 sm:grid-cols-2">
        {VARIANTS.map((option) => {
          const active = option.value === variant;
          return (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              onClick={() => setVariant(option.value)}
              className={`rounded-xl border-[1.5px] px-4 py-3.5 text-left transition ${
                active
                  ? "border-accent bg-accent/[0.06]"
                  : "border-line-strong bg-cream hover:border-fg-mute"
              }`}
            >
              <span
                className={`block text-sm font-extrabold ${
                  active ? "text-accent" : "text-ink"
                }`}
              >
                {option.label}
              </span>
              <span className="mt-0.5 block text-xs leading-[1.45] text-fg-dim">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>

      <Stamp as="div" className="mb-2 mt-5">
        {t("Embed code")}
      </Stamp>
      {/* eslint-disable-next-line no-restricted-syntax -- read-only embed
          code on an ink surface; fieldChrome is cream-palette only. */}
      <textarea
        id="ride-embed-code"
        aria-label={t("Embed code")}
        readOnly
        value={snippet}
        rows={7}
        className="w-full rounded-xl border border-ink bg-ink px-5 py-[18px] font-mono text-[12.5px] leading-[1.65] text-cream/90 focus:outline-none"
      />

      {copyState === "copied" && (
        <p className="mt-3 text-sm font-semibold text-accent">
          {t("Embed code copied")}
        </p>
      )}
      {copyState === "error" && (
        <p className="mt-3 text-sm text-red-500">
          {t(
            "Could not copy automatically. Select the code and copy it manually. ",
          )}
        </p>
      )}
    </Card>
  );
}
