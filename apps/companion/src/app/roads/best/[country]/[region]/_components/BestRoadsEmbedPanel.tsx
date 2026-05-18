"use client";
import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Check, Code2, Copy } from "lucide-react";
import {
  buildBestRoadsIframeCode,
  type BestRoadsWidgetVariant,
} from "@/lib/best-roads-embed";
interface Props {
  origin: string;
  country: string;
  region: string;
  subregion?: string;
  regionName: string;
}
const VARIANTS: Array<{
  value: BestRoadsWidgetVariant;
  label: string;
  description: string;
}> = [
  {
    value: "compact",
    label: "Compact",
    description: "Best for sidebars and narrow article columns.",
  },
  {
    value: "landscape",
    label: "Landscape",
    description: "Best for full-width article sections and newsletters.",
  },
];
export function BestRoadsEmbedPanel({
  origin,
  country,
  region,
  subregion,
  regionName,
}: Props) {
  const [variant, setVariant] = useState<BestRoadsWidgetVariant>("compact");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const snippet = useMemo(
    () =>
      buildBestRoadsIframeCode(origin, {
        country,
        region,
        subregion,
        regionName,
        variant,
      }),
    [origin, country, region, subregion, regionName, variant],
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
    <section className="mb-8 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-accent">
            <Code2 size={14} />
            {t("Embed widget ")}
          </div>
          <h2 className="mt-3 text-lg font-semibold">
            {t("Share this region as a mini-map ")}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            {t(
              "Copy an iframe snippet for blogs, ride reports, newsletters, or forums. The widget stays responsive, keeps Tarmoto branding, and links back to the full road-quality page. ",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-accent/90"
        >
          {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          {t("Copy embed code ")}
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {VARIANTS.map((option) => {
          const active = option.value === variant;
          return (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              onClick={() => setVariant(option.value)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                active
                  ? "border-accent bg-accent/10 text-white"
                  : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
              }`}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="mt-0.5 block text-xs text-slate-400">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label
          htmlFor="best-roads-embed-code"
          className="mb-2 block text-sm font-medium text-slate-300"
        >
          {t("Embed code ")}
        </label>
        <textarea
          id="best-roads-embed-code"
          aria-label={t("Embed code")}
          readOnly
          value={snippet}
          rows={7}
          className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-3 font-mono text-xs text-slate-200 focus:outline-none"
        />
      </div>

      {copyState === "copied" && (
        <p className="mt-3 text-sm text-emerald-300">
          {t("Embed code copied")}
        </p>
      )}
      {copyState === "error" && (
        <p className="mt-3 text-sm text-rose-300">
          {t(
            "Could not copy automatically. Select the code and copy it manually. ",
          )}
        </p>
      )}
    </section>
  );
}
