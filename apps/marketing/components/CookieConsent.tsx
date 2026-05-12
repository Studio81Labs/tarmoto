"use client";

import { useEffect, useState } from "react";

const UMAMI_WEBSITE_ID = "8c1c6826-6667-4653-b97f-40077d2f957d";
const UMAMI_URL = "https://cloud.umami.is/script.js";
const STORAGE_KEY = "tarmoto:cookie-consent";
const OPEN_EVENT = "tarmoto:open-cookie-banner";

function umamiAlreadyInjected(): boolean {
  return !!document.querySelector(
    `script[data-website-id="${UMAMI_WEBSITE_ID}"]`,
  );
}

function injectUmami(): void {
  if (umamiAlreadyInjected()) return;
  const script = document.createElement("script");
  script.defer = true;
  script.src = UMAMI_URL;
  script.dataset.websiteId = UMAMI_WEBSITE_ID;
  document.head.appendChild(script);
}

function readConsent(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeConsent(value: "accepted" | "declined"): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage may be unavailable (private mode)
  }
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = readConsent();
    if (stored === "accepted") {
      injectUmami();
      setVisible(false);
    } else if (stored === "declined") {
      setVisible(false);
    } else {
      setVisible(true);
    }

    const onOpen = () => setVisible(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const onAccept = () => {
    writeConsent("accepted");
    injectUmami();
    setVisible(false);
  };

  const onDecline = () => {
    // If Umami was already injected this session (user previously accepted
    // and is now revoking via cookie preferences), reload so the analytics
    // runtime is torn down — removing the <script> tag alone doesn't
    // unhook listeners it already attached.
    const wasInjected = umamiAlreadyInjected();
    writeConsent("declined");
    setVisible(false);
    if (wasInjected) {
      window.location.reload();
    }
  };

  return (
    <div
      id="cookie-banner"
      className="cookie-banner"
      role="dialog"
      aria-live="polite"
      aria-labelledby="cookie-banner-title"
      hidden={!visible}
    >
      <div className="cookie-banner-inner">
        <div className="cookie-banner-copy">
          <span className="stamp">Privacy</span>
          <p id="cookie-banner-title" className="cookie-banner-text">
            We use Umami, a privacy-friendly analytics tool, to understand
            traffic on this site. Nothing is loaded until you accept. You can
            change this at any time from the footer.
          </p>
        </div>
        <div className="cookie-banner-actions">
          <button
            type="button"
            onClick={onDecline}
            className="cookie-banner-btn decline"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="cookie-banner-btn accept"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
