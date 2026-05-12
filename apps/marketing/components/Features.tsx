const features = [
  {
    t: "Branchable drafts",
    s: "Fork a route idea, compare alternatives, and keep the better one.",
  },
  {
    t: "Elevation profile",
    s: "See climb, descent, and grade before committing to a route.",
  },
  {
    t: "Road-type aware",
    s: "Asphalt, paved, unknown, gravel, cobble — visible instead of hidden.",
  },
  {
    t: "GPX import / export",
    s: "Bring routes in, tune them, and export them back out when needed.",
  },
  {
    t: "Distance & time budget",
    s: "Planned tooling for shaping routes around distance, time, and return constraints.",
  },
  {
    t: "Companion app",
    s: "iOS and Android companion for opening synced routes and riding offline.",
  },
];

export function Features() {
  return (
    <section id="features" className="section">
      <div className="container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 05</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">Capabilities</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          Just the tools planning a real ride needs.
        </h2>
        <div className="feature-grid fade-up">
          {features.map((f) => (
            <div key={f.t} className="feature-cell">
              <div className="feature-cell-title">{f.t}</div>
              <div className="feature-cell-desc">{f.s}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
