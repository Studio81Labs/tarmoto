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

export type { FormatContext, Formatters } from "@tarmoto/shared";
