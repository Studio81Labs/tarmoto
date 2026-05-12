const pillars = [
  {
    n: "01",
    t: "Plan on a real screen",
    s: "Planning a 200 km ride on a phone is painful. Tarmoto is desktop-first: big map, full keyboard, drag points, branch alternatives, compare drafts side by side. The way you actually plan a Saturday.",
  },
  {
    n: "02",
    t: "Twisty, not broken",
    s: "A great road is twisty and smooth. Tarmoto biases your route toward better asphalt, away from rough or unknown surfaces, and lets you set the floor. No more 30 km of cratered tarmac mid-loop.",
  },
  {
    n: "03",
    t: "Send it. Ride it.",
    s: "When the route is right, send it to your phone. Offline-ready, simple turn cues. The route is the artifact — the phone companion keeps the ride simple.",
  },
];

export function Pillars() {
  return (
    <section className="section">
      <div className="container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 01</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">What it is</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          Why Tarmoto exists.
        </h2>
        <div className="pillar-grid fade-up">
          {pillars.map((p) => (
            <div key={p.n} className="pillar-card">
              <div className="mono pillar-num">{p.n}</div>
              <div className="pillar-title">{p.t}</div>
              <div className="pillar-body">{p.s}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
