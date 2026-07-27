import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@tarmoto/shared";
import { PUBLIC_LOCALE_QUERY_PARAM } from "./constants";

/** Build the stable, indexable URL for one language variant of a public page. */
export function publicLocalePath(
  pathname: string,
  locale: SupportedLocale,
): string {
  if (locale === DEFAULT_LOCALE) return pathname;
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}${PUBLIC_LOCALE_QUERY_PARAM}=${encodeURIComponent(locale)}`;
}

/** Next metadata language alternates generated from the canonical registry. */
export function publicLanguageAlternates(
  pathname: string,
): Record<string, string> {
  return Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [
      locale,
      publicLocalePath(pathname, locale),
    ]),
  );
}
