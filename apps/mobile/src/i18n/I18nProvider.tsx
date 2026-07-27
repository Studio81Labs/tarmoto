import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Alert } from "react-native";
import {
  DEFAULT_LOCALE,
  LOCALES,
  getActiveLocale,
  isSupportedLocale,
  localeDirection,
  resolveLocale,
  setActiveLocale,
  translate,
  tDynamic,
  type EnglishMessageKey,
  type SupportedLocale,
  type TranslationValues,
} from ".";
import { isLayoutDirectionReady, syncLayoutDirection } from "./layoutDirection";

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
  const [publishedLocale, setPublishedLocale] = useState(() => {
    if (isLayoutDirectionReady(localeDirection(resolvedLocale))) {
      return resolvedLocale;
    }
    const activeLocale = getActiveLocale();
    return isSupportedLocale(activeLocale) ? activeLocale : DEFAULT_LOCALE;
  });
  const publishedLocaleRef = useRef(publishedLocale);
  const [, rerenderAfterPublish] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  // Publish to non-React services only after React commits this locale. A
  // render may be suspended, abandoned, or throw; mutating the module-global
  // seam during render would let notifications/vehicle surfaces observe a
  // locale the UI never committed.
  useLayoutEffect(() => {
    if (!syncLayoutDirection(localeDirection(resolvedLocale))) {
      const currentLocale = publishedLocaleRef.current;
      Alert.alert(
        translate("Restart required", undefined, currentLocale),
        translate(
          "Restart Tarmoto to apply the new language direction.",
          undefined,
          currentLocale,
        ),
      );
      return;
    }
    setActiveLocale(resolvedLocale);
    publishedLocaleRef.current = resolvedLocale;
    setPublishedLocale(resolvedLocale);
    // Module-level translate()/t() remains the intentional seam for native
    // surfaces and legacy render paths. Re-render descendants after publishing
    // so their committed copy cannot stay on the previous global locale.
    rerenderAfterPublish();
  }, [resolvedLocale]);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: publishedLocale,
      localeLabel: LOCALES[publishedLocale].label,
      t: (key, values) => tDynamic(key, values, publishedLocale),
    }),
    [publishedLocale],
  );

  // The post-publication update must traverse module-level translate()/t()
  // consumers even when the caller passed the same child element objects.
  // Cloning preserves their type, key, props, refs, and mounted state.
  const refreshedChildren = React.Children.map(children, (child) =>
    React.isValidElement(child) ? React.cloneElement(child) : child,
  );

  return (
    <I18nContext.Provider value={value}>
      {refreshedChildren}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useTranslation(): I18nContextValue["t"] {
  return useContext(I18nContext).t;
}
