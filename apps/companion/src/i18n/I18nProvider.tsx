"use client";

import { createContext, useContext, useMemo } from "react";
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  type TranslationValues,
  resolveLocale,
  translate,
} from ".";

type I18nContextValue = {
  locale: SupportedLocale;
  t: (key: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
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
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: resolvedLocale,
      t: (key, values) => translate(key, values, resolvedLocale),
    }),
    [resolvedLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
