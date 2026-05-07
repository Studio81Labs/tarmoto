"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/i18n/I18nProvider";
import { usePathname } from "next/navigation";

const AuthenticatedAppProviders = dynamic(() =>
  import("./AuthenticatedAppProviders").then(
    (module) => module.AuthenticatedAppProviders,
  ),
);

export function AppProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return <I18nProvider>{children}</I18nProvider>;
  }

  return (
    <I18nProvider>
      <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>
    </I18nProvider>
  );
}
