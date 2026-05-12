const faq: Array<[string, string]> = [
  [
    "Where does the road quality data come from?",
    'We start from public OpenStreetMap surface and smoothness tags as a baseline, and estimate quality only where data exists. Beta rider feedback is planned to refine the picture over time. Segments we don\'t have signal on are clearly marked as "unknown" — you can choose to avoid them rather than guess.',
  ],
  [
    "Is this another phone GPS app?",
    "No. Tarmoto starts with planning on a bigger screen — Mac, Windows, or web. The phone companion is for the ride itself: open the route you prepared, keep it available offline, and follow simple cues. We're not trying to make complex route planning happen on a small screen.",
  ],
  [
    "How does it compare to Calimoto, Kurviger, Rever?",
    'They are good apps and we use some of them. Tarmoto is desktop-first, with side-by-side draft comparison, finer control over surface and curvature, and an explicit "unknown roads" filter. If you do most of your planning on a phone, those apps may suit you better.',
  ],
  [
    "Can I import my existing GPX routes?",
    "GPX import and export are part of the plan. The goal is to let you bring existing routes into the planner, inspect their surface/quality breakdown where data exists, tune them, and export them again.",
  ],
  [
    "What about privacy?",
    "No ads, no data resale. Routes sync between your devices through your account; rides recorded on the phone stay on the phone unless you choose to share. You'll be able to export or delete your data. We'll publish a full privacy policy before public launch.",
  ],
  [
    "When will it be available?",
    "Waitlist is open now. We're aiming for a first private beta in summer 2026, a wider European beta in autumn, and a v1.0 target in late 2026 or early 2027. These are intentions, not guarantees — we'll write to you when there's an invite to give.",
  ],
];

export function Faq() {
  return (
    <section id="faq" className="faq">
      <div className="container faq-container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 08</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">FAQ</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          Questions, answered plainly.
        </h2>
        <div className="faq-list fade-up">
          {faq.map(([q, a], i) => (
            <details key={q} className="faq-item" open={i === 0}>
              <summary>
                <span className="faq-q">{q}</span>
                <span className="faq-toggle" aria-hidden="true">
                  <span className="faq-toggle-plus">+</span>
                  <span className="faq-toggle-minus">−</span>
                </span>
              </summary>
              <div className="faq-a">{a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
