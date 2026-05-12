"use client";

import { useEffect, useState } from "react";
import Script from "next/script";

const STORAGE_KEY = "tarmoto:consent";
const UMAMI_WEBSITE_ID = "8c1c6826-6667-4653-b97f-40077d2f957d";

type Consent = "accepted" | "rejected" | null;

function readConsent(): Consent {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "accepted" || value === "rejected" ? value : null;
}

export function Analytics() {
  const [consent, setConsent] = useState<Consent>(null);

  useEffect(() => {
    setConsent(readConsent());

    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<Consent>).detail ?? null;
      setConsent(detail);
    };
    window.addEventListener(
      "tarmoto:consent-change",
      onChange as EventListener,
    );
    return () =>
      window.removeEventListener(
        "tarmoto:consent-change",
        onChange as EventListener,
      );
  }, []);

  if (consent !== "accepted") return null;

  return (
    <Script
      src="https://cloud.umami.is/script.js"
      data-website-id={UMAMI_WEBSITE_ID}
      strategy="afterInteractive"
    />
  );
}
