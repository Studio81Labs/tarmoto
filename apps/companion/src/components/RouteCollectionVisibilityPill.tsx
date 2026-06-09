import { Globe, Link2, Lock } from "lucide-react";
import type { RouteCollectionVisibility } from "@/lib/api";

/**
 * Visibility badge shared by the collections list page, detail page, and
 * public shared view so label/icon/tone changes only need to land in one
 * place. `className` is appended to the base classes for callers that need
 * layout-specific tweaks (e.g. `shrink-0` next to a flex-grow title).
 */
export function RouteCollectionVisibilityPill({
  visibility,
  className,
}: {
  visibility: RouteCollectionVisibility;
  className?: string;
}) {
  const label =
    visibility === "public"
      ? "Public"
      : visibility === "unlisted"
        ? "Unlisted"
        : "Private";
  const Icon =
    visibility === "public" ? Globe : visibility === "unlisted" ? Link2 : Lock;
  const tone =
    visibility === "public"
      ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/5"
      : visibility === "unlisted"
        ? "border-accent/30 text-accent bg-accent/5"
        : // Outline style like public/unlisted (tinted border + light `/5`
          // inner), but neutral grey needs a darker `-600` text to stay
          // legible on the cream dashboard — a light `-300`/`-400` grey
          // washes out against the near-transparent fill.
          "border-slate-500/40 text-slate-600 bg-slate-500/5";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}${
        className ? ` ${className}` : ""
      }`}
    >
      <Icon size={10} />
      {label}
    </span>
  );
}
