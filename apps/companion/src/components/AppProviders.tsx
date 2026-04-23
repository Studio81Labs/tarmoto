"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const AuthenticatedAppProviders = dynamic(() =>
  import("./AuthenticatedAppProviders").then(
    (module) => module.AuthenticatedAppProviders,
  ),
);

export function AppProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return children;
  }

  return <AuthenticatedAppProviders>{children}</AuthenticatedAppProviders>;
}
