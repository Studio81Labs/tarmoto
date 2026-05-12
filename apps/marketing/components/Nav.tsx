"use client";

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
        <a href="/" className="nav-logo">
          <span className="nav-logo-mark" aria-hidden="true">
            <BrandMark size={20} />
          </span>
          <span className="nav-logo-text">Tarmoto</span>
        </a>
        <div className="nav-links">
          {links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <button type="button" className="nav-cta" onClick={open}>
            Join the waitlist
          </button>
        </div>
      </div>
    </nav>
  );
}
