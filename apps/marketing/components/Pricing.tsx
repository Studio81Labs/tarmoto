// Pricing intent mirrors the canonical SUBSCRIPTION_PRICING / PLAN_CATALOG
// in packages/shared + apps/backend so the public page doesn't quote numbers
// that disagree with checkout. If those canonical values change, update them
// here too (or wire the marketing app into @tarmoto/shared as a follow-up).
const tiers = [
  {
    name: "Free",
    price: "€0",
    cadence: "forever",
    pitch: "Plan a ride, see road quality, ride with the companion.",
    feats: [
      "Basic navigation",
      "Road quality overlay (limited)",
      "Hazard alerts",
      "1 active trip",
    ],
    highlight: false,
  },
  {
    name: "Pro",
    price: "€29.99",
    cadence: "per year · planned",
    pitch: "Unlimited planning, offline maps, GPX export.",
    feats: [
      "Unlimited trip planning",
      "Full road quality zoom",
      "Offline maps",
      "GPX export",
    ],
    highlight: true,
  },
  {
    name: "Premium",
    price: "€49.99",
    cadence: "per year · planned",
    pitch: "For group organisers and power users.",
    feats: [
      "Everything in Pro",
      "Unlimited group rides",
      "Priority hazard alerts",
      "Advanced analytics",
    ],
    highlight: false,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="pricing">
      <div className="container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 07</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">Pricing intent</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          Just subscriptions. <em>That&apos;s the whole business.</em>
        </h2>
        <p className="section-lede fade-up">
          Pricing is directional. Beta is free. We will confirm the final plan
          before charging anyone. No ads, no data resale.
        </p>

        <div className="pricing-grid fade-up">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`pricing-card ${t.highlight ? "highlight" : ""}`}
            >
              <div className="pricing-card-head">
                <div className="pricing-card-name">{t.name}</div>
                {t.highlight && (
                  <span className="mono pricing-card-rec">PLANNED</span>
                )}
              </div>
              <div className="pricing-card-pitch">{t.pitch}</div>
              <div className="pricing-card-price">
                <div className="pricing-card-amount">{t.price}</div>
                <span className="mono pricing-card-cadence">{t.cadence}</span>
              </div>
              <div className="pricing-card-feats">
                {t.feats.map((f) => (
                  <div key={f} className="pricing-card-feat">
                    <span className="pricing-card-bullet">·</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
