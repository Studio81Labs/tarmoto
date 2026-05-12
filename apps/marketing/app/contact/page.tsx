import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the team behind Tarmoto.",
};

export default function ContactPage() {
  return (
    <>
      <Nav />

      <section className="subpage">
        <div className="subpage-container">
          <div className="eyebrow">
            <span className="eyebrow-num">§</span>
            <span className="eyebrow-rule"></span>
            <span className="stamp">Contact</span>
          </div>

          <h1 className="subpage-title">Get in touch.</h1>

          <p className="subpage-lede">
            We&apos;re a small team. The fastest way to reach us is email — we
            read everything, even when we can&apos;t reply right away.
          </p>

          <div className="subpage-body">
            <h2>General</h2>
            <p>
              <a href="mailto:hello@tarmoto.app">hello@tarmoto.app</a>
            </p>

            <h2>Press &amp; partnerships</h2>
            <p>
              <a href="mailto:press@tarmoto.app">press@tarmoto.app</a>
            </p>

            <h2>Privacy &amp; data requests</h2>
            <p>
              <a href="mailto:privacy@tarmoto.app">privacy@tarmoto.app</a>
            </p>

            <h2>Company</h2>
            <dl>
              <dt>Legal entity</dt>
              <dd>Studio81 Labs, s.r.o.</dd>
            </dl>

            <p>
              For the waitlist, just use the{" "}
              <a href="/#waitlist">form on the home page</a> — we&apos;ll write
              once when your invite is ready.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
