"use client";

import { createContext, useContext, useMemo } from "react";
import {
  createFormatters,
  DEFAULT_FORMAT_LOCALE,
  type Formatters,
  type UnitSystem,
} from "@tarmoto/shared";
import { usePreferencesStore } from "@/stores/preferences";

const FormatContext = createContext<Formatters>(
  createFormatters({ locale: DEFAULT_FORMAT_LOCALE, units: "metric" }),
);

/**
 * Binds `createFormatters` to the request's format preferences. Props are
 * ALWAYS the server-resolved cookie values (see format/server.ts) — never
 * read `navigator` here — so server HTML and the hydration pass agree by
 * construction. Units switch to the client store only after it hydrates
 * (a normal post-hydration state update); the units cookie keeps that
 * switch a no-op in the steady state.
 */
export function FormatProvider({
  children,
  formatLocale,
  timeZone,
  units,
}: {
  children: React.ReactNode;
  formatLocale: string;
  timeZone: string;
  units: UnitSystem;
}) {
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const storeUnits = usePreferencesStore((s) => s.unitSystem);
  const effectiveUnits = hydrated ? storeUnits : units;

  const value = useMemo(
    () =>
      createFormatters({
        locale: formatLocale,
        timeZone,
        units: effectiveUnits,
      }),
    [formatLocale, timeZone, effectiveUnits],
  );

  return (
    <FormatContext.Provider value={value}>{children}</FormatContext.Provider>
  );
}

/** The client-side formatting seam. Server components use `getServerFormatters()`. */
export function useFormat(): Formatters {
  return useContext(FormatContext);
}
