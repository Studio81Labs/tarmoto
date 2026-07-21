import { Globe, Link2, Lock } from "lucide-react";
import { t } from "@/i18n";
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
      ? t("Public")
      : visibility === "unlisted"
        ? t("Unlisted")
        : t("Private");
  const Icon =
    visibility === "public" ? Globe : visibility === "unlisted" ? Link2 : Lock;
  const tone =
    visibility === "public"
      ? "border-emerald-500/30 text-emerald-700 bg-emerald-500/5"
      : visibility === "unlisted"
        ? "border-accent/30 text-accent bg-accent/5"
        : // Outline style like public/unlisted (tinted border + light inner),
          // in a neutral ink grey. `text-ink/70` keeps the 10px label legible
          // on the near-transparent fill (a lighter tone washes out).
          "border-ink/25 text-ink/70 bg-ink/[0.05]";
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
