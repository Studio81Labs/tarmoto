import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  createFormatters,
  type FormatContext as SharedFormatContext,
  type Formatters,
} from "@tarmoto/shared";
import { setActiveFormatContext } from ".";

const DEFAULT_CONTEXT: SharedFormatContext = {
  locale: "en",
  units: "metric",
};

const FormatContext = createContext<Formatters>(
  createFormatters(DEFAULT_CONTEXT),
);

/**
 * Binds shared locale-aware formatters to the current rider/device context.
 * Updating the context refreshes React consumers and the synchronous seam used
 * by non-React services.
 */
export function FormatProvider({
  children,
  locale,
  timeZone,
  units,
}: {
  children: React.ReactNode;
  locale?: string | null;
  timeZone?: string | null;
  units?: "metric" | "imperial" | null;
}) {
  const context = useMemo<SharedFormatContext>(() => {
    const base: SharedFormatContext = {
      locale: locale || DEFAULT_CONTEXT.locale,
      units: units === "imperial" ? "imperial" : "metric",
    };
    return timeZone ? { ...base, timeZone } : base;
  }, [locale, timeZone, units]);
  const value = useMemo(() => createFormatters(context), [context]);
  // Keep the synchronous native/background seam aligned with committed UI.
  // Render-phase publication can leak an abandoned concurrent render.
  useLayoutEffect(() => {
    setActiveFormatContext(context);
  }, [context]);

  return (
    <FormatContext.Provider value={value}>{children}</FormatContext.Provider>
  );
}

export function useFormat(): Formatters {
  return useContext(FormatContext);
}
