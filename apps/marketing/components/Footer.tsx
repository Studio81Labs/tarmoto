"use client";

import { BrandMark } from "@/components/BrandMark";

interface FooterLink {
  label: string;
  href: string;
}

const cols: Array<{ h: string; links: FooterLink[] }> = [
  {
    h: "Product",
    links: [
      { label: "Planner", href: "/#planner" },
      { label: "What's planned", href: "/#roadmap" },
    ],
  },
  {
    h: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    h: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

const COOKIE_STORAGE_KEY = "tarmoto:cookie-consent";
const COOKIE_OPEN_EVENT = "tarmoto:open-cookie-banner";

export function Footer() {
  const year = new Date().getFullYear();

  const openCookiePreferences = () => {
    try {
      localStorage.removeItem(COOKIE_STORAGE_KEY);
    } catch {
      // storage may be unavailable
    }
    window.dispatchEvent(new CustomEvent(COOKIE_OPEN_EVENT));
  };

  return (
    <footer>
      <div className="container">
        <div className="footer-grid">
          <div>
            <div className="footer-brand">
              <span className="footer-logo-mark" aria-hidden="true">
                <BrandMark size={18} />
              </span>
              <span className="footer-brand-text">Tarmoto</span>
            </div>
            <p className="footer-tagline">
              A desktop-first motorcycle route planner. Built in the open, in
              early beta.
            </p>
          </div>
          {cols.map((col) => (
            <div key={col.h}>
              <span className="stamp">{col.h}</span>
              <div className="footer-col-links">
                {col.links.map((item) => (
                  <a key={item.href} href={item.href}>
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="footer-bottom mono">
          <span>© {year} TARMOTO · STUDIO81 LABS, S.R.O.</span>
          <span className="footer-bottom-right">
            EARLY BETA · PRELAUNCH
            <span className="footer-bottom-sep" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              onClick={openCookiePreferences}
              className="footer-bottom-link"
            >
              COOKIE PREFERENCES
            </button>
          </span>
        </div>
      </div>
    </footer>
  );
}
