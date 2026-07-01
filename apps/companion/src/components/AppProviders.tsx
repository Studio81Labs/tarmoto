"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/i18n/I18nProvider";
import { usePathname } from "next/navigation";
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
}: {
  children: React.ReactNode;
  locale?: string | null;
}) {
  const pathname = usePathname();

  const localeProp = locale !== undefined ? { locale } : {};

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return <I18nProvider {...localeProp}>{children}</I18nProvider>;
  }

  return (
    <I18nProvider {...localeProp}>
      <NetworkStatusProvider />
      <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>
      <ToastHost />
    </I18nProvider>
  );
}
