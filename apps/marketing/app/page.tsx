import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { PlannerMap } from "@/components/PlannerMap";
import { WaitlistForm } from "@/components/WaitlistForm";
import { ScrollReveal } from "@/components/ScrollReveal";

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

const milestones = [
  { m: "May 2026", t: "Waitlist opens", state: "current" },
  { m: "Summer 2026", t: "First private beta", state: "future" },
  { m: "Autumn 2026", t: "Wider European beta", state: "future" },
  { m: "Late 2026 / Early 2027", t: "v1.0 target", state: "future" },
];

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
    name: "Premium",
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
    name: "Pro",
    price: "€49.99",
    cadence: "per year · planned",
    pitch: "For group organisers and power users.",
    feats: [
      "Everything in Premium",
      "Unlimited group rides",
      "Priority hazard alerts",
      "Advanced analytics",
    ],
    highlight: false,
  },
];

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

const trustNote = "BUILT AROUND OPENSTREETMAP DATA";

const avoidPills: Array<[string, boolean]> = [
  ["Villages", true],
  ["Motorways", true],
  ["Unknown roads", true],
  ["Tunnels", false],
  ["Gravel", false],
  ["Ferries", false],
];

const curvatureBars = [2, 3, 4, 3, 5, 4, 5, 5, 4, 5];

export default function HomePage() {
  return (
    <>
      <ScrollReveal />
      <Nav />

      {/* HERO */}
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-text">
            <div className="hero-badge">
              <span className="hero-badge-dot"></span>
              <span className="mono hero-badge-text">
                PRIVATE BETA · SUMMER 2026
              </span>
            </div>
            <h1 className="serif hero-title">
              Plan motorcycle rides
              <br />
              on a <em>real screen.</em>
            </h1>
            <p className="hero-sub">
              Tarmoto is a desktop-first route planner for motorcyclists who
              actually plan rides. Built for twisty roads, surface awareness,
              and fewer surprises. Sync the route to your phone companion and
              ride.
            </p>
            <div id="waitlist" className="hero-waitlist">
              <WaitlistForm stage="waitlist" />
            </div>
            <div className="hero-platforms">
              <span>
                <span className="hero-platforms-strong">
                  Mac · Windows · Web
                </span>{" "}
                for planning
              </span>
              <span className="hero-platforms-sep">·</span>
              <span>
                <span className="hero-platforms-strong">iOS &amp; Android</span>{" "}
                companion for riding
              </span>
            </div>
          </div>

          {/* Hero planner panel mock */}
          <div className="hero-panel">
            <div className="hero-panel-frame">
              <div className="hero-panel-chrome">
                <div className="hero-panel-dots">
                  <span style={{ background: "#FF5F57" }}></span>
                  <span style={{ background: "#FEBC2E" }}></span>
                  <span style={{ background: "#28C840" }}></span>
                </div>
                <div className="mono hero-panel-title">
                  tarmoto · Stelvio loop · draft 3
                </div>
                <div className="hero-panel-actions">
                  <span className="mono hero-panel-action">SAVE</span>
                  <span className="mono hero-panel-action primary">
                    SEND TO PHONE
                  </span>
                </div>
              </div>

              <div className="hero-panel-body">
                <aside className="hero-panel-sidebar">
                  <span className="stamp" style={{ fontSize: "9.5px" }}>
                    Road preferences
                  </span>
                  <div className="pref-slider">
                    <div className="pref-slider-row">
                      <span className="pref-slider-label">More curves</span>
                      <span className="mono pref-slider-value">78</span>
                    </div>
                    <div className="pref-slider-track">
                      <span
                        className="pref-slider-fill"
                        style={{ width: "78%" }}
                      ></span>
                      <span
                        className="pref-slider-thumb"
                        style={{ left: "78%" }}
                      ></span>
                    </div>
                  </div>
                  <div className="pref-slider">
                    <div className="pref-slider-row">
                      <span className="pref-slider-label">Better asphalt</span>
                      <span className="mono pref-slider-value">92</span>
                    </div>
                    <div className="pref-slider-track">
                      <span
                        className="pref-slider-fill"
                        style={{ width: "92%" }}
                      ></span>
                      <span
                        className="pref-slider-thumb"
                        style={{ left: "92%" }}
                      ></span>
                    </div>
                  </div>
                  <div className="pref-slider">
                    <div className="pref-slider-row">
                      <span className="pref-slider-label">Scenic</span>
                      <span className="mono pref-slider-value">64</span>
                    </div>
                    <div className="pref-slider-track">
                      <span
                        className="pref-slider-fill"
                        style={{ width: "64%" }}
                      ></span>
                      <span
                        className="pref-slider-thumb"
                        style={{ left: "64%" }}
                      ></span>
                    </div>
                  </div>
                  <div className="hero-panel-divider"></div>
                  <span className="stamp" style={{ fontSize: "9.5px" }}>
                    Avoid
                  </span>
                  <div className="pref-toggle on">
                    <span>Unknown roads</span>
                    <span className="pref-toggle-switch">
                      <span></span>
                    </span>
                  </div>
                  <div className="pref-toggle on">
                    <span>Villages</span>
                    <span className="pref-toggle-switch">
                      <span></span>
                    </span>
                  </div>
                  <div className="pref-toggle on">
                    <span>Motorways</span>
                    <span className="pref-toggle-switch">
                      <span></span>
                    </span>
                  </div>
                  <div className="pref-toggle off">
                    <span>Gravel</span>
                    <span className="pref-toggle-switch">
                      <span></span>
                    </span>
                  </div>
                </aside>

                <div className="hero-panel-map">
                  <PlannerMap />
                  <div className="map-overlay map-overlay-tl">
                    <span className="stamp" style={{ fontSize: "9px" }}>
                      Route
                    </span>
                    <div className="map-overlay-strong">
                      4 stops · 187 km · 4h 38m
                    </div>
                  </div>
                  <div className="map-overlay map-overlay-bottom">
                    <div>
                      <span className="stamp" style={{ fontSize: "9px" }}>
                        Asphalt mix
                      </span>
                      <div className="asphalt-mix">
                        <span
                          style={{ flex: 6, background: "var(--q5)" }}
                        ></span>
                        <span
                          style={{ flex: 3, background: "var(--q4)" }}
                        ></span>
                        <span
                          style={{ flex: 1, background: "var(--q3)" }}
                        ></span>
                      </div>
                      <div className="mono asphalt-mix-text">
                        60% great · 30% ok · 10% rough
                      </div>
                    </div>
                    <div className="map-overlay-divider"></div>
                    <div>
                      <span className="stamp" style={{ fontSize: "9px" }}>
                        Climb
                      </span>
                      <div className="map-overlay-strong">+2,140 m</div>
                    </div>
                    <div className="map-overlay-divider"></div>
                    <div>
                      <span className="stamp" style={{ fontSize: "9px" }}>
                        Curves / km
                      </span>
                      <div className="map-overlay-strong">3.8</div>
                    </div>
                    <div className="map-overlay-zoom">
                      <span>−</span>
                      <span>+</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* TRUST STRIP */}
      <section className="trust-strip">
        <div className="container trust-inner">
          <span className="stamp">Foundation</span>
          <div className="trust-logos">
            <span>{trustNote}</span>
          </div>
          <span className="mono trust-made">EARLY BETA · WAITLIST OPEN</span>
        </div>
      </section>

      {/* PILLARS */}
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

      {/* PLANNER DEEP */}
      <section id="planner" className="planner-deep">
        <div className="container">
          <div className="eyebrow fade-up">
            <span className="eyebrow-num">§ 02</span>
            <span className="eyebrow-rule"></span>
            <span className="stamp">The planner</span>
          </div>
          <h2 className="serif h-display section-h fade-up">
            Tune the route. Don&apos;t redraw it.
          </h2>
          <p className="section-lede fade-up">
            You set the start, the end, and a few stops. Tarmoto draws a first
            draft. From there you adjust the dials — curvature, surface, village
            density, scenery — and the route re-paths in place.
          </p>

          <div className="planner-deep-grid fade-up">
            <div className="planner-deep-map">
              <div className="planner-deep-map-frame">
                <PlannerMap />
                <div className="planner-deep-stops">
                  {["Stelvio Pass", "Gavia", "Mortirolo", "Bormio"].map(
                    (n, i) => (
                      <span key={n} className="planner-deep-stop">
                        <span className="mono planner-deep-stop-letter">
                          {String.fromCharCode(65 + i)}
                        </span>
                        {n}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </div>

            <div className="control-rail">
              <div className="control-card">
                <div className="control-card-row">
                  <div className="control-card-title">Curvature</div>
                  <div className="mono control-card-value">78</div>
                </div>
                <div className="control-card-hint">More twisty</div>
                <div className="bars">
                  {curvatureBars.map((v, i) => (
                    <span
                      key={i}
                      className={v >= 4 ? "bars-active" : ""}
                      style={{ height: `${v * 18}%` }}
                    />
                  ))}
                </div>
              </div>

              <div className="control-card">
                <div className="control-card-row">
                  <div className="control-card-title">Asphalt minimum</div>
                  <div className="mono control-card-value">Great</div>
                </div>
                <div className="control-card-hint">Avoid anything below 4★</div>
                <div className="asphalt-min">
                  {[1, 2, 3, 4, 5].map((q) => (
                    <div
                      key={q}
                      className={`asphalt-min-cell ${q >= 4 ? "active" : ""}`}
                    >
                      <span className="qbars">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <span
                            key={n}
                            style={{
                              width: "3px",
                              height: "6.6px",
                              background:
                                n <= q
                                  ? Q_VARS[q - 1]
                                  : "rgba(232,229,222,0.10)",
                            }}
                          />
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="control-card">
                <div className="control-card-row">
                  <div className="control-card-title">Avoid</div>
                </div>
                <div className="control-card-hint">Tap to toggle</div>
                <div className="avoid-pills">
                  {avoidPills.map(([l, on]) => (
                    <span key={l} className={`avoid-pill ${on ? "on" : "off"}`}>
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ROAD QUALITY */}
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
            <span className="rq-emph">5 (hero asphalt)</span>, using
            OpenStreetMap surface and smoothness tags as a baseline. Rider
            feedback is planned to sharpen confidence over time. Segments
            without signal are clearly marked — you can choose to avoid them.
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

      {/* WORKFLOW */}
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
            The desktop is where the route gets shaped. The phone is where it
            gets used. The two stay in sync — once the route is synced, the
            riding flow works offline.
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
              <svg
                width="60"
                height="40"
                viewBox="0 0 60 40"
                aria-hidden="true"
              >
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

      {/* FEATURES */}
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

      {/* WHY THIS EXISTS */}
      <section id="about" className="founder">
        <div className="founder-inner">
          <span className="stamp">Why this exists</span>
          <div className="serif founder-quote">
            “Most motorcycle route apps start on the phone. That is fine for
            navigation, but painful for planning. Tarmoto starts on a real
            screen: bigger map, better context, more control, and fewer
            surprises once you are already on the road.”
          </div>
          <div className="founder-credit">
            <div className="founder-credit-text">
              <div className="founder-role">
                Built by riders, for riders planning longer weekend routes.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ROADMAP */}
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
                autumn, with v1.0 targeted for late 2026 or early 2027. These
                are intentions — we&apos;ll say so when something slips.
              </p>
            </div>
            <div className="roadmap-card">
              {milestones.map((s) => (
                <div key={s.m} className="roadmap-row">
                  <span
                    className={`roadmap-dot ${s.state}`}
                    aria-hidden="true"
                  />
                  <span className="mono roadmap-month">
                    {s.m.toUpperCase()}
                  </span>
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

      {/* PRICING */}
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

      {/* FAQ */}
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

      {/* FINAL CTA */}
      <section className="final-cta">
        <div className="final-cta-inner">
          <span className="stamp">First private beta · Summer 2026</span>
          <h2 className="serif final-cta-h">
            Plan a ride <em>worth riding.</em>
          </h2>
          <p className="final-cta-lede">
            We&apos;re inviting riders in small batches. One email when your
            turn comes around.
          </p>
          <div className="final-cta-form">
            <WaitlistForm stage="waitlist" />
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
