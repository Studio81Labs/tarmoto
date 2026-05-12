"use client";

import type { ReactNode } from "react";

const STORAGE_KEY = "tarmoto:cookie-consent";
const OPEN_EVENT = "tarmoto:open-cookie-banner";

export function CookiePreferencesLink({ children }: { children: ReactNode }) {
  return (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault();
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // storage may be unavailable
        }
        window.dispatchEvent(new CustomEvent(OPEN_EVENT));
      }}
    >
      {children}
    </a>
  );
}
