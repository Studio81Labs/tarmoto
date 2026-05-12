import { PlannerMap } from "@/components/PlannerMap";

const workflowSteps: ReadonlyArray<readonly [string, string, string]> = [
  ["01", "Plan", "Set start, end, stops. Build a first draft quickly."],
  [
    "02",
    "Tune",
    "Curves, surface, scenery, avoidances. Adjust the route before you ride.",
  ],
  ["03", "Sync", "Send the route to your phone and keep it available offline."],
  [
    "04",
    "Ride",
    "Mount the phone. Open the synced route. Ride without signal anxiety.",
  ],
];

const workflowExtras = [
  {
    t: "GPX in & out",
    d: "Import existing GPX files and export routes for tools and devices that understand GPX.",
  },
  {
    t: "Multi-stop drafts",
    d: "Plan multi-stop routes, keep alternatives, and compare distance, climb, and surface mix.",
  },
  {
    t: "Offline riding",
    d: "The goal is simple: sync before you leave, then keep map, route, and cues usable without signal.",
  },
];

export function Workflow() {
  return (
    <section id="workflow" className="workflow">
      <div className="container">
        <div className="eyebrow fade-up">
          <span className="eyebrow-num">§ 04</span>
          <span className="eyebrow-rule"></span>
          <span className="stamp">Workflow</span>
        </div>
        <h2 className="serif h-display section-h fade-up">
          Four steps. <em>Plan. Tune. Sync. Ride.</em>
        </h2>
        <p className="section-lede fade-up">
          The desktop is where the route gets shaped. The phone is where it gets
          used. The two stay in sync — once the route is synced, the riding flow
          works offline.
        </p>

        <div className="workflow-steps fade-up">
          {workflowSteps.map(([n, t, d]) => (
            <div key={n} className="workflow-step">
              <div className="mono workflow-step-num">{n}</div>
              <div className="workflow-step-title">{t}</div>
              <div className="workflow-step-desc">{d}</div>
            </div>
          ))}
        </div>

        <div className="workflow-sync fade-up">
          <div className="workflow-desktop">
            <div className="workflow-desktop-chrome">
              <div className="workflow-desktop-dots">
                <span style={{ background: "#FF5F57" }}></span>
                <span style={{ background: "#FEBC2E" }}></span>
                <span style={{ background: "#28C840" }}></span>
              </div>
              <div className="mono workflow-desktop-title">
                tarmoto.app — Stelvio loop
              </div>
            </div>
            <div className="workflow-desktop-map">
              <PlannerMap />
              <div className="workflow-synced">
                <span className="workflow-synced-dot"></span>
                <span className="mono workflow-synced-text">
                  SYNCED · 14:22
                </span>
              </div>
            </div>
          </div>

          <div className="workflow-arrow">
            <span className="mono workflow-arrow-sync">SYNC</span>
            <svg width="60" height="40" viewBox="0 0 60 40" aria-hidden="true">
              <path
                d="M 6 20 L 50 20 M 42 12 L 50 20 L 42 28"
                stroke="var(--sync)"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="mono workflow-arrow-note">OFFLINE READY</div>
          </div>

          <div className="workflow-phone-wrap">
            <div className="phone">
              <div className="phone-screen">
                <div className="phone-status">
                  <span className="mono phone-time">9:41</span>
                  <span className="mono phone-icons">● ▲</span>
                </div>
                <div className="phone-header">
                  <span className="stamp" style={{ fontSize: "9px" }}>
                    Today
                  </span>
                  <div className="phone-route">Stelvio loop</div>
                  <div className="phone-meta">187 km · 4h 38m</div>
                </div>
                <div className="phone-map">
                  <PlannerMap />
                </div>
                <div className="phone-cta">
                  <span className="phone-cta-icon">▶</span>
                  <div>
                    <div className="phone-cta-title">Start ride</div>
                    <div className="phone-cta-sub">Offline · simple cues</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="workflow-extras fade-up">
          {workflowExtras.map((f) => (
            <div key={f.t} className="workflow-extra">
              <div className="workflow-extra-title">{f.t}</div>
              <div className="workflow-extra-desc">{f.d}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
