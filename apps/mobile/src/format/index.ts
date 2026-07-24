import {
  createFormatters,
  DEFAULT_FORMAT_LOCALE,
  type FormatContext,
  type Formatters,
} from "@tarmoto/shared";

let activeFormatters = createFormatters({
  locale: DEFAULT_FORMAT_LOCALE,
  units: "metric",
});

export function setActiveFormatContext(context: FormatContext): Formatters {
  activeFormatters = createFormatters(context);
  return activeFormatters;
}

/** Synchronous formatting seam for helpers and native vehicle surfaces. */
export function getFormatters(): Formatters {
  return activeFormatters;
}

/**
 * Format a whole number for content rendered by a locale-specific surface
 * (such as TTS) without inheriting the rider's independent display locale.
 */
export function formatIntegerForLocale(value: number, locale: string): string {
  return createFormatters({ locale, units: "metric" }).number(value, {
    maximumFractionDigits: 0,
    useGrouping: false,
  });
}

export type { FormatContext, Formatters } from "@tarmoto/shared";
