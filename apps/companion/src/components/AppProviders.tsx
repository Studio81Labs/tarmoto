"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/i18n/I18nProvider";
import { usePathname } from "next/navigation";
import { NetworkStatusProvider } from "./NetworkStatusProvider";

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

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return <I18nProvider locale={locale}>{children}</I18nProvider>;
  }

  return (
    <I18nProvider locale={locale}>
      <NetworkStatusProvider />
      <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>
    </I18nProvider>
  );
}
