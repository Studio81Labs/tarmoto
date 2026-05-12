"use client";

import Link from "next/link";

import { BrandMark } from "@/components/BrandMark";
import { useWaitlist } from "@/components/WaitlistProvider";

const links = [
  { href: "/#planner", label: "Planner" },
  { href: "/#workflow", label: "Workflow" },
  { href: "/#road-quality", label: "Road quality" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

export function Nav() {
  const { open } = useWaitlist();

  return (
    <nav id="nav" className="nav">
      <div className="nav-inner">
        <Link href="/" className="nav-logo">
          <span className="nav-logo-mark" aria-hidden="true">
            <BrandMark size={20} />
          </span>
          <span className="nav-logo-text">Tarmoto</span>
        </Link>
        <div className="nav-links">
          {links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          {/* Anchor + onClick (not <button>) so the CTA still works
              before React hydrates or with JS disabled — the native
              href scrolls to the inline waitlist form on the home
              page, and once hydrated the click handler opens the
              modal instead. */}
          <Link
            href="/#waitlist"
            className="nav-cta"
            onClick={(event) => {
              event.preventDefault();
              open();
            }}
          >
            Join the waitlist
          </Link>
        </div>
      </div>
    </nav>
  );
}
