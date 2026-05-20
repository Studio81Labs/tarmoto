"use client";

import { createContext, useContext, useMemo } from "react";
import {
  DEFAULT_LOCALE,
  LOCALES,
  type SupportedLocale,
  type TranslationValues,
  resolveLocale,
  setActiveLocale,
  translate,
} from ".";

type I18nContextValue = {
  locale: SupportedLocale;
  localeLabel: string;
  t: (key: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  localeLabel: LOCALES[DEFAULT_LOCALE].label,
  t: (key, values) => translate(key, values, DEFAULT_LOCALE),
});

export function I18nProvider({
  children,
  locale,
}: {
  children: React.ReactNode;
  locale?: string | null;
}) {
  const resolvedLocale = resolveLocale(locale);
  setActiveLocale(resolvedLocale);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: resolvedLocale,
      localeLabel: LOCALES[resolvedLocale].label,
      t: (key, values) => translate(key, values, resolvedLocale),
    }),
    [resolvedLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

/** Convenience hook for components that only need the translator. */
export function useTranslation() {
  return useContext(I18nContext).t;
}
