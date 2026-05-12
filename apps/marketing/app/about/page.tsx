import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "About",
  description: "Why Tarmoto exists and what we're building.",
};

export default function AboutPage() {
  return (
    <>
      <Nav />

      <section className="legal-page">
        <div className="legal-inner">
          <div className="legal-eyebrow">
            <span className="stamp">About</span>
          </div>

          <h1 className="serif legal-title">Why Tarmoto exists.</h1>

          <div className="legal-content">
            <p className="lead">
              Most motorcycle route apps start on the phone.
            </p>

            <p>
              That works well enough for navigation, but planning a full-day or
              weekend ride on a small screen is still frustrating: too little
              context, too much tapping, too many surprises once you&apos;re
              already on the road.
            </p>

            <p>Tarmoto is built around a different idea:</p>

            <p className="quote">
              <strong>Plan on a real screen first. Ride second.</strong>
            </p>

            <p>The goal is simple:</p>

            <ul>
              <li>bigger map</li>
              <li>clearer road context</li>
              <li>better surface awareness</li>
              <li>easier route comparison</li>
              <li>fewer bad road surprises halfway through a ride</li>
            </ul>

            <p>Desktop is where the route gets shaped.</p>

            <p>
              The phone companion is there to keep the ride simple: sync the
              route, open it offline, and follow the ride without fighting menus
              or rebuilding the route on the side of the road.
            </p>

            <h2>What we&apos;re building</h2>

            <p>
              Tarmoto is a desktop-first motorcycle route planner focused on:
            </p>

            <ul>
              <li>twisty roads</li>
              <li>surface awareness</li>
              <li>route comparison</li>
              <li>GPX workflows</li>
              <li>offline riding support</li>
              <li>long weekend and touring rides</li>
            </ul>

            <p>
              We&apos;re especially interested in routes where road quality
              matters just as much as the shape of the road itself.
            </p>

            <p>The current direction includes:</p>

            <ul>
              <li>route drafting and comparison</li>
              <li>surface and &ldquo;unknown road&rdquo; awareness</li>
              <li>GPX import/export</li>
              <li>offline-ready companion experience</li>
              <li>planning tools designed for larger screens</li>
            </ul>

            <p>
              Some features shown on the site are still in development or
              planned for future beta releases.
            </p>

            <h2>Current stage</h2>

            <p>Tarmoto is currently in early development.</p>

            <p>
              The waitlist is open now, with a first private beta planned for
              summer 2026 and a wider European beta planned afterward.
            </p>

            <p>
              We prefer shipping carefully over pretending everything is
              finished.
            </p>

            <p>If something slips, we&apos;ll say so.</p>

            <h2>Philosophy</h2>

            <p>
              We want Tarmoto to feel closer to a well-made touring tool than a
              noisy social platform.
            </p>

            <p>That means:</p>

            <ul>
              <li>no ads</li>
              <li>no engagement feeds</li>
              <li>no growth hacks</li>
              <li>no selling rider data</li>
            </ul>

            <p>Just better planning and better rides.</p>

            <h2>Built by riders</h2>

            <p>
              Tarmoto is being built by people who already plan rides the hard
              way: saved GPX files, bookmarked roads, screenshots, notes, maps,
              and route revisions spread across multiple tools.
            </p>

            <p>The goal is not to replace riding.</p>

            <p>
              The goal is to spend less time fighting route tools and more time
              on roads worth remembering.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
