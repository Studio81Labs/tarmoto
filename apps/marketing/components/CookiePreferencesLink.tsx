"use client";

import type { ReactNode } from "react";

export function CookiePreferencesLink({ children }: { children: ReactNode }) {
  return (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("tarmoto:reset-consent"));
      }}
    >
      {children}
    </a>
  );
}
