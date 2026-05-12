import { PlannerMap } from "@/components/PlannerMap";
import { WaitlistForm } from "@/components/WaitlistForm";

export function Hero() {
  return (
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
            actually plan rides. Built for twisty roads, surface awareness, and
            fewer surprises. Sync the route to your phone companion and ride.
          </p>
          <div id="waitlist" className="hero-waitlist">
            <WaitlistForm stage="waitlist" />
          </div>
          <div className="hero-platforms">
            <span>
              <span className="hero-platforms-strong">Mac · Windows · Web</span>{" "}
              for planning
            </span>
            <span className="hero-platforms-sep">·</span>
            <span>
              <span className="hero-platforms-strong">iOS &amp; Android</span>{" "}
              companion for riding
            </span>
          </div>
        </div>

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
                <PrefSlider label="More curves" value={78} />
                <PrefSlider label="Better asphalt" value={92} />
                <PrefSlider label="Scenic" value={64} />
                <div className="hero-panel-divider"></div>
                <span className="stamp" style={{ fontSize: "9.5px" }}>
                  Avoid
                </span>
                <PrefToggle label="Unknown roads" on />
                <PrefToggle label="Villages" on />
                <PrefToggle label="Motorways" on />
                <PrefToggle label="Gravel" on={false} />
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
                      <span style={{ flex: 6, background: "var(--q5)" }}></span>
                      <span style={{ flex: 3, background: "var(--q4)" }}></span>
                      <span style={{ flex: 1, background: "var(--q3)" }}></span>
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
  );
}

function PrefSlider({ label, value }: { label: string; value: number }) {
  return (
    <div className="pref-slider">
      <div className="pref-slider-row">
        <span className="pref-slider-label">{label}</span>
        <span className="mono pref-slider-value">{value}</span>
      </div>
      <div className="pref-slider-track">
        <span
          className="pref-slider-fill"
          style={{ width: `${value}%` }}
        ></span>
        <span
          className="pref-slider-thumb"
          style={{ left: `${value}%` }}
        ></span>
      </div>
    </div>
  );
}

function PrefToggle({ label, on }: { label: string; on: boolean }) {
  return (
    <div className={`pref-toggle ${on ? "on" : "off"}`}>
      <span>{label}</span>
      <span className="pref-toggle-switch">
        <span></span>
      </span>
    </div>
  );
}
