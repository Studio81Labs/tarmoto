// screens-c.jsx — Post-ride summary & stats dashboard + Profile.

function PostRideScreen({ onDone, onShare }) {
  const t = useT();
  const onDark = t.dark;
  const quality = [
    [42, 4, "Good"],
    [28, 5, "Excellent"],
    [16, 2, "Poor"],
    [14, 3, "Fair"],
  ];
  const splits = [
    { name: "Innsbruck → Brenner", km: 38, q: 5, t: "46:10" },
    { name: "Brenner → Trafoi", km: 64, q: 4, t: "1:24:30" },
    { name: "Stelvio climb", km: 42, q: 2, t: "1:08:55" },
    { name: "Stelvio → Bormio", km: 42, q: 5, t: "52:20" },
  ];
  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <TopBar
        title="Ride summary"
        onBack={onDone}
        onDark={onDark}
        right={
          <button
            onClick={onShare}
            style={{
              width: 38,
              height: 38,
              borderRadius: 999,
              border: "1px solid " + (onDark ? t.invLine : t.line),
              background: onDark ? "rgba(255,255,255,0.06)" : t.raised,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: onDark ? "#F3EEE6" : t.fg,
            }}
          >
            <Icon name="share" size={18} />
          </button>
        }
      />
      <Scroll pad={20} bottomPad={120}>
        <Stamp>Saved 14:22 · Apr 19</Stamp>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: t.track,
            marginTop: 4,
          }}
        >
          Stelvio, smashed.
        </div>
        <div
          style={{
            fontFamily: t.mono,
            fontSize: 11.5,
            color: t.mute,
            marginTop: 4,
          }}
        >
          INNSBRUCK → BORMIO · DAY 1 OF 4
        </div>

        {/* hero */}
        <div
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: t.rLg,
            background: "#141519",
            color: "#F5EFE6",
            overflow: "hidden",
          }}
        >
          <MiniRoute h={130} progress={1} onDark />
          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 8,
            }}
          >
            {[
              ["186", "km"],
              ["4:12", "moving"],
              ["89", "km/h peak"],
              ["2,758", "m peak"],
            ].map(([n, l]) => (
              <div key={l}>
                <div
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 19,
                    lineHeight: 1,
                  }}
                >
                  {n}
                </div>
                <div
                  style={{
                    fontFamily: t.mono,
                    fontSize: 9,
                    color: "rgba(245,239,230,0.55)",
                    marginTop: 4,
                    letterSpacing: 0.3,
                  }}
                >
                  {l}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* quality breakdown */}
        <Card raised pad={16} style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Stamp>Tarmac encountered</Stamp>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span
                style={{ fontFamily: t.sans, fontWeight: 800, fontSize: 20 }}
              >
                3.8
              </span>
              <Stamp size={9}>avg / 5</Stamp>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 12,
              height: 12,
              borderRadius: 6,
              overflow: "hidden",
              gap: 2,
            }}
          >
            {quality.map(([pct, q], i) => (
              <div
                key={i}
                style={{ width: `${pct}%`, background: QC[q - 1] }}
              />
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            {quality.map(([pct, q, l], i) => (
              <div
                key={i}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: QC[q - 1],
                  }}
                />
                <span
                  style={{ fontFamily: t.sans, fontWeight: 700, fontSize: 12 }}
                >
                  {pct}%
                </span>
                <span style={{ fontSize: 11, color: t.mute }}>{l}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* elevation */}
        <Card raised pad={16} style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <Stamp>Elevation profile</Stamp>
            <Stamp size={9} color={t.mute}>
              +2,758 m gain
            </Stamp>
          </div>
          <ElevProfile h={64} onDark={onDark} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontFamily: t.mono,
              fontSize: 10,
              color: t.mute,
            }}
          >
            <span>620 m</span>
            <span>STELVIO 2,758 m</span>
            <span>1,225 m</span>
          </div>
        </Card>

        {/* splits */}
        <div style={{ marginTop: 14, marginBottom: 10 }}>
          <Stamp>Splits</Stamp>
        </div>
        <Card raised pad={0} style={{ overflow: "hidden" }}>
          {splits.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 15px",
                borderBottom:
                  i < splits.length - 1 ? "1px solid " + t.line : "none",
              }}
            >
              <div
                style={{
                  width: 4,
                  alignSelf: "stretch",
                  minHeight: 30,
                  borderRadius: 2,
                  background: QC[s.q - 1],
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 700,
                    fontSize: 13.5,
                  }}
                >
                  {s.name}
                </div>
                <div
                  style={{
                    fontFamily: t.mono,
                    fontSize: 11,
                    color: t.mute,
                    marginTop: 2,
                  }}
                >
                  {s.km} km · {s.t}
                </div>
              </div>
              <QBars q={s.q} size={6} />
            </div>
          ))}
        </Card>

        {/* achievements */}
        <div style={{ marginTop: 14, marginBottom: 10 }}>
          <Stamp>Unlocked this ride</Stamp>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            ["mountain", "Passo Stelvio", t.accent, true],
            ["phone", "186 km mapped", null, false],
            ["gauge", "48° max lean", null, false],
          ].map(([ic, label, bg, hl], i) => (
            <div
              key={i}
              style={{
                flex: 1,
                padding: 13,
                borderRadius: t.r,
                background: hl ? t.accent : onDark ? t.raised : t.raised2,
                color: hl ? "#0E0E10" : t.fg,
                border: hl ? "none" : "1px solid " + t.line,
              }}
            >
              <Icon name={ic} size={22} color={hl ? "#0E0E10" : t.dim} />
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 12.5,
                  marginTop: 8,
                  lineHeight: 1.2,
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          <Btn
            onDark={onDark}
            size="lg"
            onClick={onShare}
            icon={
              <Icon name="share" size={18} color={onDark ? "#0E0E10" : t.bg} />
            }
          >
            Share ride
          </Btn>
        </div>
      </Scroll>
    </Screen>
  );
}

// ── PROFILE ─────────────────────────────────────────────────────
function ProfileScreen({ cfg, onSettings }) {
  const t = useT();
  const onDark = t.dark;
  const stats = [
    ["12,480", "km ridden"],
    ["86", "rides"],
    ["1,284", "km mapped"],
    ["9", "badges"],
  ];
  const rows = [
    ["route", "My rides", "86", null],
    ["heart", "Saved roads", "24", null],
    ["alert", "My reports", "31", null],
    ["settings", "Settings", "", onSettings],
    ["phone", "Linked devices", "2", null],
  ];
  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <Scroll pad={20} bottomPad={120}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            paddingTop: 6,
          }}
        >
          <Avatar size={64} />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 22,
                letterSpacing: -0.4,
              }}
            >
              Luca Moretti
            </div>
            <div
              style={{
                fontFamily: t.mono,
                fontSize: 11.5,
                color: t.mute,
                marginTop: 3,
              }}
            >
              Ducati Monster · Bolzano
            </div>
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 11px",
              borderRadius: 999,
              background: t.invBg,
              color: t.invFg,
              fontFamily: t.sans,
              fontWeight: 800,
              fontSize: 11,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 9,
                background: t.accent,
              }}
            />{" "}
            PRO
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          {stats.map(([n, l]) => (
            <Card raised key={l} pad={14}>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 24,
                  lineHeight: 1,
                }}
              >
                {n}
              </div>
              <div style={{ marginTop: 5 }}>
                <Stamp size={9}>{l}</Stamp>
              </div>
            </Card>
          ))}
        </div>

        {/* personal road map */}
        <Card raised pad={16} style={{ marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <Stamp>Roads explored · Beskydy</Stamp>
            <Stamp size={9} color={t.accent}>
              62%
            </Stamp>
          </div>
          <MiniRoute h={110} progress={0.62} onDark={onDark} seed={2} />
        </Card>

        <div style={{ marginTop: 14 }}>
          <Card raised pad={0} style={{ overflow: "hidden" }}>
            {rows.map(([ic, label, val, act], i) => (
              <div
                key={label}
                onClick={act || undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 13,
                  padding: "15px 16px",
                  cursor: act ? "pointer" : "default",
                  borderBottom:
                    i < rows.length - 1 ? "1px solid " + t.line : "none",
                }}
              >
                <Icon name={ic} size={20} color={t.dim} />
                <div
                  style={{
                    flex: 1,
                    fontFamily: t.sans,
                    fontWeight: 600,
                    fontSize: 15,
                  }}
                >
                  {label}
                </div>
                {val && (
                  <span
                    style={{ fontFamily: t.mono, fontSize: 12, color: t.mute }}
                  >
                    {val}
                  </span>
                )}
                <Icon name="right" size={17} color={t.faint} />
              </div>
            ))}
          </Card>
        </div>
      </Scroll>
    </Screen>
  );
}

Object.assign(window, { PostRideScreen, ProfileScreen });
