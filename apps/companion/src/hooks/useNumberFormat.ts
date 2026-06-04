"use client";

import { useCallback, useMemo } from "react";
import { useI18n } from "@/i18n/I18nProvider";

export interface NumberFormatter {
  /** Active BCP-47 locale the formatter resolves to. */
  locale: string;
  /** Format a number per the active locale (e.g. `12643.8` → `12 643,8` in et). */
  format: (value: number, options?: Intl.NumberFormatOptions) => string;
}

/**
 * Central number-formatting seam for the app. Today it derives purely from the
 * active i18n locale, so every numeric display (KPI tiles, stats, …) groups and
 * decimalises consistently. It's a hook — not a bare helper — so that when users
 * gain custom number preferences (separators, decimal places, beyond today's
 * metric/imperial unit toggle) we layer them in here and every call site updates
 * without change.
 */
export function useNumberFormat(): NumberFormatter {
  const { locale } = useI18n();
  const format = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      value.toLocaleString(locale, options),
    [locale],
  );
  return useMemo(() => ({ locale, format }), [locale, format]);
}
