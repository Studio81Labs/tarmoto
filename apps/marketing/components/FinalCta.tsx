import { WaitlistForm } from "@/components/WaitlistForm";

export function FinalCta() {
  return (
    <section className="final-cta">
      <div className="final-cta-inner">
        <span className="stamp">First private beta · Summer 2026</span>
        <h2 className="serif final-cta-h">
          Plan a ride <em>worth riding.</em>
        </h2>
        <p className="final-cta-lede">
          We&apos;re inviting riders in small batches. One email when your turn
          comes around.
        </p>
        <div className="final-cta-form">
          <WaitlistForm stage="waitlist" />
        </div>
      </div>
    </section>
  );
}
