"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/i18n/I18nProvider";
import { FormatProvider } from "@/format/FormatProvider";
import type { FormatPrefs } from "@/format";
import { NetworkStatusProvider } from "./NetworkStatusProvider";
import { ToastHost } from "./ToastHost";

const AuthenticatedAppProviders = dynamic(() =>
  import("./AuthenticatedAppProviders").then(
    (module) => module.AuthenticatedAppProviders,
  ),
);

export function AppProviders({
  children,
  locale,
  formatPrefs,
}: {
  children: React.ReactNode;
  locale?: string | null;
  formatPrefs: FormatPrefs;
}) {
  const localeProp = locale !== undefined ? { locale } : {};
  const formatProps = {
    formatLocale: formatPrefs.formatLocale,
    timeZone: formatPrefs.timeZone,
    units: formatPrefs.units,
  };

  return (
    <I18nProvider {...localeProp}>
      <FormatProvider {...formatProps}>
        <NetworkStatusProvider />
        <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>
        <ToastHost />
      </FormatProvider>
    </I18nProvider>
  );
}
