import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Tarmoto handles your data during the prelaunch beta.",
};

export default function PrivacyPage() {
  return (
    <>
      <Nav />

      <section className="subpage">
        <div className="subpage-container">
          <div className="eyebrow">
            <span className="eyebrow-num">§</span>
            <span className="eyebrow-rule"></span>
            <span className="stamp">Privacy</span>
          </div>

          <h1 className="subpage-title">Privacy policy.</h1>

          <p className="subpage-lede">
            Tarmoto is in early beta. This page describes what we collect today.
            We&apos;ll publish a full privacy policy before public launch — it
            will grow as the product grows, never the other way around.
          </p>

          <div className="subpage-body">
            <h2>Who is responsible</h2>
            <p>
              The data controller is <strong>Studio81 Labs, s.r.o.</strong>,
              operator of Tarmoto. For data requests email{" "}
              <a href="mailto:privacy@tarmoto.app">privacy@tarmoto.app</a>.
            </p>

            <h2>What we collect</h2>
            <ul>
              <li>
                <strong>Waitlist submission.</strong> When you join the waitlist
                we store the email address you submit, a timestamp, the page or
                form that triggered the signup (<em>source</em>), an optional
                rider type if the form collects it, the country your request
                originated from (derived from your IP by our hosting provider —
                we do not store the raw IP address), and the browser User-Agent
                string. The country and User-Agent help us spot abuse and shape
                the beta invite mix; nothing else is derived from them.
              </li>
              <li>
                <strong>Analytics.</strong> We load Umami — a privacy-friendly,
                cookieless analytics tool we self-host — which counts page views
                and basic referrer information. No cookies, no cross-site
                tracking, no personal profiles, and the data stays on
                infrastructure we operate.
              </li>
            </ul>

            <h2>Why we collect it</h2>
            <ul>
              <li>
                <strong>Email:</strong> to send you a confirmation message with
                an unsubscribe link when you join the waitlist, one more message
                when invites open, and a final one when v1.0 ships.
              </li>
              <li>
                <strong>Analytics:</strong> to understand how many people are
                interested and which sections of the site they read.
              </li>
            </ul>

            <h2>Legal basis (GDPR)</h2>
            <p>
              For email, consent — you give it by submitting the waitlist form,
              and you can withdraw at any time (see &ldquo;Your rights&rdquo;
              below). For analytics, legitimate interest: we use{" "}
              <a href="https://umami.is/" rel="noreferrer">
                Umami
              </a>{" "}
              in a cookieless, privacy-friendly configuration that doesn&apos;t
              store cookies, doesn&apos;t track you across sites, and
              doesn&apos;t collect personal data, so no consent banner is
              required.
            </p>

            <h2>Retention</h2>
            <p>
              Waitlist emails are kept until the product launches publicly or
              you ask us to remove them, whichever comes first. Analytics data
              is kept for as long as we run the Umami project for Tarmoto.
            </p>

            <h2>Sharing</h2>
            <p>
              We don&apos;t sell or share your data with advertisers. We
              don&apos;t run ads on this site. The waitlist record itself is
              stored on infrastructure we operate (Cloudflare KV).
            </p>
            <p>
              To deliver the confirmation email and the unsubscribe link tied to
              it, we send your email address to{" "}
              <a href="https://resend.com" rel="noreferrer">
                Resend
              </a>
              , our transactional email provider, acting as a data processor on
              our instructions. Resend sees the email address, the message, and
              the technical metadata needed to deliver it; we don&apos;t pass
              them anything else, and we don&apos;t use them for marketing. If
              we ever switch providers or change how waitlist data is processed,
              we&apos;ll update this page.
            </p>

            <h2>Your rights</h2>
            <p>
              Under GDPR you can access, correct, or delete the data we hold
              about you, and you can withdraw consent at any time. To exercise
              any of these rights, email{" "}
              <a href="mailto:privacy@tarmoto.app">privacy@tarmoto.app</a>.
            </p>

            <p className="subpage-meta">
              This is a prelaunch policy and will be replaced by a full version
              before public launch.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
