"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "tarmoto:consent";

type Consent = "accepted" | "rejected" | null;

function broadcast(consent: Consent) {
  window.dispatchEvent(
    new CustomEvent<Consent>("tarmoto:consent-change", { detail: consent }),
  );
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== "accepted" && stored !== "rejected") {
      setVisible(true);
    }

    const onReset = () => {
      window.localStorage.removeItem(STORAGE_KEY);
      broadcast(null);
      setVisible(true);
    };
    window.addEventListener("tarmoto:reset-consent", onReset);
    return () => window.removeEventListener("tarmoto:reset-consent", onReset);
  }, []);

  const choose = (decision: "accepted" | "rejected") => {
    window.localStorage.setItem(STORAGE_KEY, decision);
    broadcast(decision);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      id="cookie-banner"
      className="cookie-banner"
      role="dialog"
      aria-label="Cookie and analytics consent"
      aria-live="polite"
    >
      <div className="cookie-banner-inner">
        <div className="cookie-banner-copy">
          <span className="stamp">Privacy</span>
          <p className="cookie-banner-text">
            Tarmoto uses privacy-friendly analytics (
            <a
              href="https://umami.is/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Umami
            </a>
            ) to understand how the site is used. No personal data is sold and
            no advertising trackers are loaded.{" "}
            <a href="/privacy">Read our privacy policy</a>.
          </p>
        </div>
        <div className="cookie-banner-actions">
          <button
            type="button"
            className="cookie-banner-btn decline"
            onClick={() => choose("rejected")}
          >
            Reject
          </button>
          <button
            type="button"
            className="cookie-banner-btn accept"
            onClick={() => choose("accepted")}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
