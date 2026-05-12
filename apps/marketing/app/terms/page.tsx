import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms governing the use of Tarmoto.",
};

export default function TermsPage() {
  return (
    <>
      <Nav />

      <section className="legal-page">
        <div className="legal-inner">
          <div className="legal-eyebrow">
            <span className="stamp">Legal</span>
          </div>

          <h1 className="serif legal-title">Terms of Use</h1>

          <div className="legal-meta">Last updated: May 2026</div>

          <div className="legal-content">
            <p>
              These Terms of Use govern your access to and use of Tarmoto,
              including the website, waitlist, companion applications, and
              related services.
            </p>

            <p>By using Tarmoto, you agree to these terms.</p>

            <h2>1. Early-stage service</h2>

            <p>
              Tarmoto is currently an early-stage product under active
              development.
            </p>

            <p>
              Features, pricing, availability, compatibility, and functionality
              may change at any time without notice.
            </p>

            <p>
              Some functionality shown on the website may still be planned,
              experimental, or limited to beta users.
            </p>

            <p>
              We make no guarantee that any feature, beta timeline, or release
              target will ship exactly as described.
            </p>

            <h2>2. Accounts and waitlist</h2>

            <p>You may join the waitlist by submitting your email address.</p>

            <p>If you later create an account:</p>

            <ul>
              <li>you are responsible for maintaining access to it</li>
              <li>you are responsible for activity under your account</li>
              <li>you must provide accurate information</li>
            </ul>

            <p>
              We may suspend or remove accounts that abuse the service or
              attempt to interfere with the platform.
            </p>

            <h2>3. Routing and road information</h2>

            <p>
              Routes, surface estimates, road quality indicators, ride cues, GPX
              processing, and related information are provided for informational
              purposes only.
            </p>

            <p>Road conditions can change at any time due to:</p>

            <ul>
              <li>weather</li>
              <li>construction</li>
              <li>closures</li>
              <li>traffic</li>
              <li>local hazards</li>
              <li>inaccurate or outdated map data</li>
            </ul>

            <p>Tarmoto does not guarantee:</p>

            <ul>
              <li>road safety</li>
              <li>route accuracy</li>
              <li>surface quality</li>
              <li>legality of access</li>
              <li>availability of roads or services</li>
            </ul>

            <p>You are solely responsible for:</p>

            <ul>
              <li>following local traffic laws</li>
              <li>observing road signs and closures</li>
              <li>riding within your ability</li>
              <li>determining whether a road or condition is safe</li>
            </ul>

            <p>Always use your own judgment while riding.</p>

            <h2>4. Beta software</h2>

            <p>
              Beta versions may contain bugs, incomplete functionality, crashes,
              inaccurate routing, or data loss.
            </p>

            <p>You use beta software at your own risk.</p>

            <p>We strongly recommend:</p>

            <ul>
              <li>reviewing routes before riding</li>
              <li>carrying backup navigation when appropriate</li>
              <li>avoiding reliance on unfinished features in remote areas</li>
            </ul>

            <h2>5. Intellectual property</h2>

            <p>
              All branding, design, software, text, and original content
              associated with Tarmoto are protected by applicable intellectual
              property laws.
            </p>

            <p>You may not:</p>

            <ul>
              <li>copy or resell the service</li>
              <li>reverse engineer protected parts of the platform</li>
              <li>misuse branding or assets</li>
              <li>attempt unauthorized access to systems or infrastructure</li>
            </ul>

            <p>
              OpenStreetMap and other third-party data sources remain subject to
              their respective licenses.
            </p>

            <h2>6. Privacy</h2>

            <p>
              Our handling of personal data is described in the Privacy Policy.
            </p>

            <p>We do not sell personal rider data or route history.</p>

            <h2>7. Availability</h2>

            <p>
              We do not guarantee uninterrupted availability of the service.
            </p>

            <p>
              The platform may be modified, paused, or discontinued at any time,
              especially during early development and beta operation.
            </p>

            <h2>8. Limitation of liability</h2>

            <p>
              To the maximum extent permitted by law, Tarmoto and its operators
              are not liable for:
            </p>

            <ul>
              <li>accidents</li>
              <li>injuries</li>
              <li>traffic violations</li>
              <li>vehicle damage</li>
              <li>route errors</li>
              <li>navigation failures</li>
              <li>lost data</li>
              <li>interrupted travel</li>
              <li>indirect or consequential damages</li>
            </ul>

            <p>Use the service responsibly and at your own discretion.</p>

            <h2>9. Contact</h2>

            <p>Questions about these terms can be sent to:</p>

            <p>
              <a href="mailto:contact@tarmoto.app">contact@tarmoto.app</a>
            </p>

            <h2>10. Changes to these terms</h2>

            <p>We may update these Terms of Use over time.</p>

            <p>
              When changes are material, we will update the &ldquo;Last
              updated&rdquo; date on this page.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
