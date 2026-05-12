const milestones = [
  { m: "May 2026", t: "Waitlist opens", state: "current" },
  { m: "Summer 2026", t: "First private beta", state: "future" },
  { m: "Autumn 2026", t: "Wider European beta", state: "future" },
  { m: "Late 2026 / Early 2027", t: "v1.0 target", state: "future" },
];

export function Roadmap() {
  return (
    <section id="roadmap" className="section">
      <div className="container">
        <div className="roadmap-grid fade-up">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-num">§ 06</span>
              <span className="eyebrow-rule"></span>
              <span className="stamp">Where we are</span>
            </div>
            <h2 className="serif roadmap-h">
              Honest about
              <br />
              the state of things.
            </h2>
            <p className="roadmap-lede">
              We&apos;re a small team building Tarmoto in the open. A first
              private beta is planned for summer, a wider European beta in
              autumn, with v1.0 targeted for late 2026 or early 2027. These are
              intentions — we&apos;ll say so when something slips.
            </p>
          </div>
          <div className="roadmap-card">
            {milestones.map((s) => (
              <div key={s.m} className="roadmap-row">
                <span className={`roadmap-dot ${s.state}`} aria-hidden="true" />
                <span className="mono roadmap-month">{s.m.toUpperCase()}</span>
                <span className={`roadmap-label ${s.state}`}>{s.t}</span>
                {s.state === "current" && (
                  <span className="mono roadmap-now">NOW</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
