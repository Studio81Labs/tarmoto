import { PlannerMap } from "@/components/PlannerMap";

const Q_VARS = [
  "var(--q1)",
  "var(--q2)",
  "var(--q3)",
  "var(--q4)",
  "var(--q5)",
];

const avoidPills: Array<[string, boolean]> = [
  ["Villages", true],
  ["Motorways", true],
  ["Unknown roads", true],
  ["Tunnels", false],
  ["Gravel", false],
  ["Ferries", false],
];

const curvatureBars = [2, 3, 4, 3, 5, 4, 5, 5, 4, 5];

export function PlannerDeep() {
  return (
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
                              n <= q ? Q_VARS[q - 1] : "rgba(232,229,222,0.10)",
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
  );
}
