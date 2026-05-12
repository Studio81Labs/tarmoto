const qualityScale = [
  { q: 1, label: "Avoid", desc: "Broken surface or flagged hazard." },
  { q: 2, label: "Rough", desc: "Patchy. Slow-speed only." },
  { q: 3, label: "OK", desc: "Commutable. Fine in the dry." },
  { q: 4, label: "Great", desc: "Smooth, well-swept asphalt." },
  { q: 5, label: "Hero", desc: "Ribbon tarmac. Worth the detour." },
];

const Q_VARS = [
  "var(--q1)",
  "var(--q2)",
  "var(--q3)",
  "var(--q4)",
  "var(--q5)",
];

export function RoadQuality() {
  return (
    <section id="road-quality" className="section">
      <div className="container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 03</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">Road quality</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          A five-point view of the road under you.
        </h2>
        <p className="section-lede fade-up">
          We estimate road quality where data exists, from{" "}
          <span className="rq-emph">1 (avoid)</span> to{" "}
          <span className="rq-emph">5 (hero asphalt)</span>, using OpenStreetMap
          surface and smoothness tags as a baseline. Rider feedback is planned
          to sharpen confidence over time. Segments without signal are clearly
          marked — you can choose to avoid them.
        </p>

        <div className="quality-grid fade-up">
          {qualityScale.map(({ q, label, desc }) => (
            <div key={q} className="quality-card">
              <span className="qbars">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span
                    key={n}
                    style={{
                      width: "6px",
                      height: "13.2px",
                      background:
                        n <= q ? Q_VARS[q - 1] : "rgba(232,229,222,0.10)",
                    }}
                  />
                ))}
              </span>
              <div className="quality-label" style={{ color: Q_VARS[q - 1] }}>
                {label}
              </div>
              <div className="quality-desc">{desc}</div>
            </div>
          ))}
        </div>

        <div className="how-we-know fade-up">
          <span className="stamp stamp-accent">How we know</span>
          <div className="how-we-know-text">
            We start from public OpenStreetMap tags (
            <span className="mono how-we-know-mono">surface=*</span>,{" "}
            <span className="mono how-we-know-mono">smoothness=*</span>) as a
            baseline. Beta rider observations are planned to refine confidence
            on segments people actually ride. Where we don&apos;t have signal,
            we say so — and you can choose to avoid those segments.
          </div>
        </div>
      </div>
    </section>
  );
}
