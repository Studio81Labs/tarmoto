import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALES,
  resolveLocale,
  setActiveLocale,
  tDynamic,
  type EnglishMessageKey,
  type SupportedLocale,
  type TranslationValues,
} from ".";

type I18nContextValue = {
  locale: SupportedLocale;
  localeLabel: string;
  t: (key: EnglishMessageKey, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  localeLabel: LOCALES[DEFAULT_LOCALE].label,
  t: (key, values) => tDynamic(key, values, DEFAULT_LOCALE),
});

export function I18nProvider({
  children,
  locale,
}: {
  children: React.ReactNode;
  locale?: string | null;
}) {
  const resolvedLocale = resolveLocale(locale);
  // Publish to non-React services only after React commits this locale. A
  // render may be suspended, abandoned, or throw; mutating the module-global
  // seam during render would let notifications/vehicle surfaces observe a
  // locale the UI never committed.
  useLayoutEffect(() => {
    setActiveLocale(resolvedLocale);
  }, [resolvedLocale]);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: resolvedLocale,
      localeLabel: LOCALES[resolvedLocale].label,
      t: (key, values) => tDynamic(key, values, resolvedLocale),
    }),
    [resolvedLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useTranslation(): I18nContextValue["t"] {
  return useContext(I18nContext).t;
}
