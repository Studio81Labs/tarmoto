import { escapeHtmlAttribute } from "@/lib/embed-utils";

export type RideWidgetVariant = "compact" | "landscape";

interface WidgetDimensions {
  heightPx: number;
}

export function buildRideEmbedUrl(
  origin: string,
  options: { token: string; variant?: RideWidgetVariant },
): string {
  const base = origin.replace(/\/$/, "");
  const variant = options.variant ?? "compact";
  return `${base}/embed/rides/${encodeURIComponent(options.token)}?variant=${variant}`;
}

export function buildRideIframeCode(
  origin: string,
  options: {
    token: string;
    rideLabel: string;
    variant?: RideWidgetVariant;
  },
): string {
  const variant = options.variant ?? "compact";
  const src = buildRideEmbedUrl(origin, { token: options.token, variant });
  const title = escapeHtmlAttribute(
    `Tarmoto route widget for ${options.rideLabel}`,
  );

  return [
    `<iframe`,
    `  src="${escapeHtmlAttribute(src)}"`,
    `  title="${title}"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin-when-cross-origin"`,
    `  style="width:100%;max-width:960px;height:${widgetDimensions(variant).heightPx}px;border:0;overflow:hidden;border-radius:16px;"`,
    `></iframe>`,
  ].join("\n");
}

export function formatRideEmbedStat(
  value: number,
  noun: "view" | "click",
): string {
  const label = value === 1 ? noun : `${noun}s`;
  return `${new Intl.NumberFormat("en-US").format(value)} ${label}`;
}

function widgetDimensions(variant: RideWidgetVariant): WidgetDimensions {
  if (variant === "landscape") return { heightPx: 520 };
  return { heightPx: 460 };
}
