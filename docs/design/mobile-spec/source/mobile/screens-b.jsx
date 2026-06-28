// screens-b.jsx — Ride mode (turn-by-turn HUD), Crash detection, Hazard report.

// ── Custom hazard glyphs ────────────────────────────────────────
function HazardGlyph({ type, size = 24, color }) {
  const p = {
    stroke: color,
    strokeWidth: 1.8,
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  const g = {
    pothole: (
      <>
        <ellipse cx="12" cy="14" rx="7" ry="4.5" {...p} />
        <path
          d="M7 12c1.5-1 3-1.4 5-1.4s3.5.4 5 1.4"
          {...p}
          strokeDasharray="2 2"
        />
      </>
    ),
    gravel: (
      <>
        {[
          [8, 9],
          [13, 8],
          [16, 12],
          [9, 14],
          [14, 15],
          [11, 11],
        ].map((c, i) => (
          <circle
            key={i}
            cx={c[0]}
            cy={c[1]}
            r="1.6"
            fill={color}
            stroke="none"
          />
        ))}
      </>
    ),
    wet: (
      <>
        <path d="M12 4c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9Z" {...p} />
      </>
    ),
    debris: (
      <>
        <path d="M12 5 4 19h16L12 5Z" {...p} />
        <path d="M12 11v4" {...p} />
        <circle cx="12" cy="17.2" r="0.3" fill={color} stroke={color} />
      </>
    ),
    rockfall: (
      <>
        <path d="M3 19 8 9l3 5 2-3 5 8H3Z" {...p} />
        <circle cx="17" cy="6" r="2" {...p} />
      </>
    ),
    animals: (
      <>
        <circle cx="8" cy="10" r="1.8" {...p} />
        <circle cx="16" cy="10" r="1.8" {...p} />
        <circle cx="6" cy="14.5" r="1.5" {...p} />
        <circle cx="18" cy="14.5" r="1.5" {...p} />
        <path d="M9 18c0-2 1.4-3 3-3s3 1 3 3-1.4 2.5-3 2.5S9 20 9 18Z" {...p} />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      {g[type]}
    </svg>
  );
}

// ── RIDE MODE (always dark / immersive) ─────────────────────────
function RideScreen({ cfg, onReport, onEnd }) {
  const t = useT();
  const [prog, setProg] = React.useState(46);
  React.useEffect(() => {
    const iv = setInterval(() => setProg((p) => (p >= 58 ? 46 : p + 0.12)), 60);
    return () => clearInterval(iv);
  }, []);
  const glass = "rgba(16,17,21,0.86)";

  if (t.land) {
    return (
      <Screen bg="#0B0C0F" onDark>
        <div style={{ position: "absolute", inset: 0 }}>
          <TarmotoMap
            theme="dark"
            mapStyle="heatmap"
            progress={prog}
            accent={t.accent}
            showLabels={false}
          />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(to right, rgba(11,12,15,0.7), transparent 45%)",
          }}
        />
        <StatusBar onDark time="10:24" />
        {/* left HUD column */}
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 54,
            bottom: 14,
            width: 304,
            zIndex: 12,
            background: glass,
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: 22,
            padding: 16,
            color: "#F5EFE6",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 15,
                background: t.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg
                width="30"
                height="30"
                viewBox="0 0 44 44"
                style={{ transform: "rotate(-45deg)" }}
              >
                <path
                  d="M22 7v30M22 7 12 17M22 7l10 10"
                  stroke="#0E0E10"
                  strokeWidth="5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 28,
                    letterSpacing: -0.5,
                  }}
                >
                  280
                </span>
                <span
                  style={{
                    fontFamily: t.mono,
                    fontSize: 12,
                    color: "rgba(245,239,230,0.55)",
                  }}
                >
                  m
                </span>
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "rgba(245,239,230,0.7)",
                  marginTop: 1,
                }}
              >
                Left onto SS38 · Stelvio
              </div>
            </div>
          </div>
          <div
            style={{
              height: 1,
              background: "rgba(255,255,255,0.1)",
              margin: "16px 0",
            }}
          />
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span
              style={{
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 58,
                lineHeight: 0.9,
                letterSpacing: -2,
              }}
            >
              64
            </span>
            <span
              style={{
                fontFamily: t.mono,
                fontSize: 11,
                color: "rgba(245,239,230,0.5)",
                letterSpacing: 1,
              }}
            >
              KM/H
            </span>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <div
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <QBars q={2} size={6} empty="rgba(245,239,230,0.16)" />
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 9,
                  color: "rgba(245,239,230,0.5)",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                SURFACE
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <div
                style={{ fontFamily: t.sans, fontWeight: 800, fontSize: 17 }}
              >
                2,240
                <span
                  style={{
                    fontFamily: t.mono,
                    fontSize: 10,
                    color: "rgba(245,239,230,0.5)",
                    marginLeft: 2,
                  }}
                >
                  m
                </span>
              </div>
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 9,
                  color: "rgba(245,239,230,0.5)",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                ELEV
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 12,
              fontFamily: t.mono,
              fontSize: 10,
              color: "rgba(245,239,230,0.5)",
              letterSpacing: 0.5,
            }}
          >
            ARRIVAL 11:38 · 38 KM LEFT
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={onReport}
              style={{
                flex: 1,
                padding: "13px",
                borderRadius: 14,
                border: "none",
                cursor: "pointer",
                background: t.accent,
                color: "#0E0E10",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="alert" size={17} color="#0E0E10" sw={2} /> Report
            </button>
            <button
              onClick={onEnd}
              style={{
                padding: "13px 20px",
                borderRadius: 14,
                cursor: "pointer",
                background: "transparent",
                color: "#F5EFE6",
                border: "1px solid rgba(255,255,255,0.22)",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              End
            </button>
          </div>
        </div>
        {/* hazard chip */}
        <div
          style={{
            position: "absolute",
            top: 64,
            left: "calc(160px + 50%)",
            transform: "translateX(-50%)",
            zIndex: 12,
          }}
        >
          <div
            style={{
              background: "rgba(28,15,8,0.92)",
              border: "1.5px solid rgba(255,106,26,0.5)",
              backdropFilter: "blur(10px)",
              borderRadius: 999,
              padding: "7px 15px",
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: "#F5EFE6",
              fontFamily: t.mono,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: 0.3,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 9,
                background: t.accent,
              }}
            />{" "}
            POTHOLE · 2.4 KM
          </div>
        </div>
        {/* recenter */}
        <button
          style={{
            position: "absolute",
            right: 14,
            top: 64,
            zIndex: 12,
            width: 44,
            height: 44,
            borderRadius: 14,
            background: glass,
            backdropFilter: "blur(14px)",
            border: "1px solid rgba(255,255,255,0.09)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#F5EFE6",
          }}
        >
          <Icon name="nav" size={20} color={t.accent} sw={2} />
        </button>
      </Screen>
    );
  }

  return (
    <Screen bg="#0B0C0F" onDark>
      <div style={{ position: "absolute", inset: 0 }}>
        <TarmotoMap
          theme="dark"
          mapStyle="heatmap"
          progress={prog}
          accent={t.accent}
          showLabels={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(11,12,15,0.55), transparent 22%, transparent 60%, rgba(11,12,15,0.7))",
        }}
      />
      <StatusBar onDark time="10:24" />

      {/* next turn */}
      <div
        style={{
          position: "absolute",
          top: 56,
          left: 12,
          right: 12,
          zIndex: 12,
        }}
      >
        <div
          style={{
            background: glass,
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: 22,
            padding: 15,
            display: "flex",
            alignItems: "center",
            gap: 14,
            color: "#F5EFE6",
          }}
        >
          <div
            style={{
              width: 58,
              height: 58,
              borderRadius: 16,
              background: t.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              width="34"
              height="34"
              viewBox="0 0 44 44"
              style={{ transform: "rotate(-45deg)" }}
            >
              <path
                d="M22 7v30M22 7 12 17M22 7l10 10"
                stroke="#0E0E10"
                strokeWidth="5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
              <span
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 30,
                  letterSpacing: -0.5,
                }}
              >
                280
              </span>
              <span
                style={{
                  fontFamily: t.mono,
                  fontSize: 12,
                  color: "rgba(245,239,230,0.55)",
                }}
              >
                m
              </span>
            </div>
            <div
              style={{
                fontSize: 13,
                color: "rgba(245,239,230,0.7)",
                marginTop: 2,
              }}
            >
              Left onto SS38 · Stelvio
            </div>
          </div>
          <div
            style={{
              textAlign: "right",
              borderLeft: "1px solid rgba(255,255,255,0.1)",
              paddingLeft: 14,
            }}
          >
            <div style={{ fontFamily: t.sans, fontWeight: 800, fontSize: 15 }}>
              11:38
            </div>
            <div
              style={{
                fontFamily: t.mono,
                fontSize: 9,
                color: "rgba(245,239,230,0.5)",
                marginTop: 2,
              }}
            >
              ARRIVAL
            </div>
          </div>
        </div>
      </div>

      {/* hazard pre-alert */}
      <div
        style={{
          position: "absolute",
          top: 142,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 12,
        }}
      >
        <div
          style={{
            background: "rgba(28,15,8,0.92)",
            border: "1.5px solid rgba(255,106,26,0.5)",
            backdropFilter: "blur(10px)",
            borderRadius: 999,
            padding: "7px 15px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            color: "#F5EFE6",
            fontFamily: t.mono,
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 9,
              background: t.accent,
            }}
          ></span>{" "}
          POTHOLE · 2.4 KM AHEAD
        </div>
      </div>

      {/* recenter */}
      <button
        style={{
          position: "absolute",
          right: 14,
          top: 200,
          zIndex: 12,
          width: 44,
          height: 44,
          borderRadius: 14,
          background: glass,
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(255,255,255,0.09)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#F5EFE6",
        }}
      >
        <Icon name="nav" size={20} color={t.accent} sw={2} />
      </button>

      {/* bottom HUD */}
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          bottom: 22,
          zIndex: 12,
        }}
      >
        <div
          style={{
            background: glass,
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: 22,
            padding: "16px 18px",
            color: "#F5EFE6",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 50,
                  lineHeight: 0.9,
                  letterSpacing: -1.5,
                }}
              >
                64
              </div>
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 10,
                  color: "rgba(245,239,230,0.5)",
                  letterSpacing: 1,
                  marginTop: 4,
                }}
              >
                KM/H
              </div>
            </div>
            <div
              style={{
                width: 1,
                height: 46,
                background: "rgba(255,255,255,0.1)",
              }}
            />
            <div style={{ textAlign: "center" }}>
              <QBars q={2} size={7} empty="rgba(245,239,230,0.16)" />
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 9,
                  color: "rgba(245,239,230,0.5)",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                SURFACE
              </div>
            </div>
            <div
              style={{
                width: 1,
                height: 46,
                background: "rgba(255,255,255,0.1)",
              }}
            />
            <div style={{ textAlign: "center" }}>
              <div
                style={{ fontFamily: t.sans, fontWeight: 800, fontSize: 22 }}
              >
                2,240
                <span
                  style={{
                    fontFamily: t.mono,
                    fontSize: 11,
                    color: "rgba(245,239,230,0.5)",
                    marginLeft: 2,
                  }}
                >
                  m
                </span>
              </div>
              <div
                style={{
                  fontFamily: t.mono,
                  fontSize: 9,
                  color: "rgba(245,239,230,0.5)",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                ELEVATION
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={onReport}
              style={{
                flex: 1,
                padding: "13px",
                borderRadius: 14,
                border: "none",
                cursor: "pointer",
                background: t.accent,
                color: "#0E0E10",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="alert" size={17} color="#0E0E10" sw={2} /> Report
            </button>
            <button
              onClick={onEnd}
              style={{
                padding: "13px 20px",
                borderRadius: 14,
                cursor: "pointer",
                background: "transparent",
                color: "#F5EFE6",
                border: "1px solid rgba(255,255,255,0.22)",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              End
            </button>
          </div>
        </div>
      </div>
    </Screen>
  );
}

// ── CRASH DETECTION ─────────────────────────────────────────────
function CrashScreen({ onCancel }) {
  const t = useT();
  const [n, setN] = React.useState(12);
  React.useEffect(() => {
    const iv = setInterval(() => setN((v) => (v <= 0 ? 0 : v - 1)), 1000);
    return () => clearInterval(iv);
  }, []);
  const calling = n <= 0;
  const R = 96,
    C = 2 * Math.PI * R,
    frac = n / 12;

  if (t.land) {
    const R2 = 78,
      C2 = 2 * Math.PI * R2;
    return (
      <Screen bg={QC[0]} style={{ color: "#F5EFE6" }}>
        <StatusBar onDark time="14:07" />
        <div
          style={{
            position: "absolute",
            inset: 0,
            top: 50,
            display: "flex",
            alignItems: "center",
            gap: 28,
            padding: "0 40px 0 44px",
          }}
        >
          <div style={{ flex: 1 }}>
            <Stamp color="rgba(245,239,230,0.8)" style={{ letterSpacing: 2 }}>
              {calling ? "Calling for help" : "Crash detected"}
            </Stamp>
            <div
              style={{
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 40,
                letterSpacing: -1,
                marginTop: 10,
                lineHeight: 1,
              }}
            >
              {calling ? "Hold tight." : "Are you okay?"}
            </div>
            <div
              style={{
                fontSize: 13.5,
                opacity: 0.9,
                marginTop: 10,
                lineHeight: 1.45,
                maxWidth: 360,
              }}
            >
              {calling ? (
                "Sharing your live location with Elena and emergency services now."
              ) : (
                <>
                  Hard impact detected near <b>SS38 km 47</b>. We’ll alert your
                  contacts unless you cancel.
                </>
              )}
            </div>
            <button
              onClick={onCancel}
              style={{
                marginTop: 18,
                padding: "15px 28px",
                borderRadius: 16,
                border: "none",
                cursor: "pointer",
                background: "#F5EFE6",
                color: "#0E0E10",
                fontFamily: t.sans,
                fontWeight: 800,
                fontSize: 16,
              }}
            >
              {calling ? "I’m safe — stand down" : "I’m okay — cancel"}
            </button>
            <div
              style={{
                marginTop: 12,
                fontFamily: t.mono,
                fontSize: 11,
                opacity: 0.85,
                letterSpacing: 0.5,
              }}
            >
              WILL CALL → ELENA · DANI · 112
            </div>
          </div>
          <div
            style={{
              position: "relative",
              width: 196,
              height: 196,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="196"
              height="196"
              viewBox="0 0 196 196"
              style={{ position: "absolute", inset: 0 }}
            >
              <circle
                cx="98"
                cy="98"
                r={R2}
                fill="rgba(14,14,16,0.16)"
                stroke="rgba(245,239,230,0.3)"
                strokeWidth="2"
              />
              <circle
                cx="98"
                cy="98"
                r={R2}
                fill="none"
                stroke="#F5EFE6"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={C2}
                strokeDashoffset={C2 * (1 - frac)}
                transform="rotate(-90 98 98)"
                style={{ transition: "stroke-dashoffset 1s linear" }}
              />
            </svg>
            <div style={{ textAlign: "center" }}>
              {calling ? (
                <Icon name="phone" size={54} color="#F5EFE6" sw={1.6} />
              ) : (
                <>
                  <div
                    style={{
                      fontFamily: t.sans,
                      fontWeight: 800,
                      fontSize: 72,
                      lineHeight: 1,
                      letterSpacing: -2,
                    }}
                  >
                    {n}
                  </div>
                  <Stamp color="rgba(245,239,230,0.75)">seconds</Stamp>
                </>
              )}
            </div>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen bg={QC[0]} style={{ color: "#F5EFE6", alignItems: "center" }}>
      <style>{`@keyframes crashpulse{0%{transform:translateX(-50%) scale(0.75);opacity:0.6}100%{transform:translateX(-50%) scale(1.35);opacity:0}}`}</style>
      <StatusBar onDark time="14:07" />
      <div
        style={{
          position: "absolute",
          top: 230,
          left: "50%",
          width: 240,
          height: 240,
          borderRadius: 999,
          border: "2px solid rgba(245,239,230,0.35)",
          animation: "crashpulse 1.6s ease-out infinite",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          textAlign: "center",
          padding: "20px 24px",
          zIndex: 2,
        }}
      >
        <Stamp color="rgba(245,239,230,0.8)" style={{ letterSpacing: 2 }}>
          {calling ? "Calling for help" : "Crash detected"}
        </Stamp>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 46,
            letterSpacing: -1,
            marginTop: 14,
            lineHeight: 1,
          }}
        >
          {calling ? "Hold tight." : "Are you okay?"}
        </div>
        <div
          style={{
            fontSize: 14.5,
            opacity: 0.9,
            marginTop: 12,
            lineHeight: 1.45,
            maxWidth: 300,
            margin: "12px auto 0",
          }}
        >
          {calling ? (
            "Sharing your live location with Elena and emergency services now."
          ) : (
            <>
              Hard impact detected near <b>SS38 km 47</b>. We’ll alert your
              contacts unless you cancel.
            </>
          )}
        </div>
      </div>
      <div
        style={{
          position: "relative",
          width: 240,
          height: 240,
          margin: "34px auto 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2,
        }}
      >
        <svg
          width="240"
          height="240"
          viewBox="0 0 240 240"
          style={{ position: "absolute", inset: 0 }}
        >
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="rgba(14,14,16,0.16)"
            stroke="rgba(245,239,230,0.3)"
            strokeWidth="2"
          />
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            stroke="#F5EFE6"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - frac)}
            transform="rotate(-90 120 120)"
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
        <div style={{ textAlign: "center", zIndex: 1 }}>
          {calling ? (
            <Icon name="phone" size={64} color="#F5EFE6" sw={1.6} />
          ) : (
            <>
              <div
                style={{
                  fontFamily: t.sans,
                  fontWeight: 800,
                  fontSize: 92,
                  lineHeight: 1,
                  letterSpacing: -3,
                }}
              >
                {n}
              </div>
              <Stamp color="rgba(245,239,230,0.75)">seconds</Stamp>
            </>
          )}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 38,
          left: 22,
          right: 22,
          zIndex: 2,
        }}
      >
        <button
          onClick={onCancel}
          style={{
            width: "100%",
            padding: 18,
            borderRadius: 18,
            border: "none",
            cursor: "pointer",
            background: "#F5EFE6",
            color: "#0E0E10",
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 18,
          }}
        >
          {calling ? "I’m safe — stand down" : "I’m okay — cancel"}
        </button>
        <div
          style={{
            marginTop: 12,
            textAlign: "center",
            fontFamily: t.mono,
            fontSize: 11,
            opacity: 0.85,
            letterSpacing: 0.5,
          }}
        >
          WILL CALL → ELENA · DANI · 112
        </div>
      </div>
    </Screen>
  );
}

// ── HAZARD REPORT ───────────────────────────────────────────────
const HAZARD_TYPES = [
  { id: "pothole", label: "Pothole" },
  { id: "gravel", label: "Gravel" },
  { id: "wet", label: "Wet road" },
  { id: "debris", label: "Debris" },
  { id: "rockfall", label: "Rockfall" },
  { id: "animals", label: "Animals" },
];

function HazardScreen({ onBack, onSubmit }) {
  const t = useT();
  const onDark = t.dark;
  const [sel, setSel] = React.useState("pothole");
  const [sev, setSev] = React.useState(2);
  const sevs = ["Minor", "Caution", "Severe"];
  const sevColor = [QC[3], QC[1], QC[0]][sev];
  return (
    <Screen onDark={onDark}>
      <StatusBar onDark={onDark} />
      <TopBar title="Report hazard" onBack={onBack} onDark={onDark} />
      <Scroll pad={20} bottomPad={30}>
        <div
          style={{
            fontFamily: t.sans,
            fontWeight: 800,
            fontSize: 26,
            letterSpacing: -0.5,
          }}
        >
          What did you hit?
        </div>
        <div style={{ fontSize: 13, color: t.dim, marginTop: 5 }}>
          One tap. We’ll attach your live location automatically.
        </div>

        <div
          style={{
            marginTop: 18,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
          }}
        >
          {HAZARD_TYPES.map((h) => {
            const on = sel === h.id;
            return (
              <button
                key={h.id}
                onClick={() => setSel(h.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "16px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                  borderRadius: t.r,
                  background: on ? t.accent : onDark ? t.raised : t.raised,
                  border: "1px solid " + (on ? "transparent" : t.line),
                  boxShadow: on ? "0 8px 22px rgba(255,106,26,0.3)" : "none",
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    flexShrink: 0,
                    background: on
                      ? "#0E0E10"
                      : onDark
                        ? "rgba(255,255,255,0.06)"
                        : t.bg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <HazardGlyph
                    type={h.id}
                    size={23}
                    color={on ? t.accent : t.fg}
                  />
                </div>
                <div
                  style={{
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 15,
                    color: on ? "#0E0E10" : t.fg,
                  }}
                >
                  {h.label}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 22 }}>
          <Stamp>How bad is it?</Stamp>
          <div style={{ marginTop: 9, display: "flex", gap: 8 }}>
            {sevs.map((s, i) => {
              const on = sev === i;
              const c = [QC[3], QC[1], QC[0]][i];
              return (
                <button
                  key={s}
                  onClick={() => setSev(i)}
                  style={{
                    flex: 1,
                    padding: "13px 0",
                    borderRadius: t.rSm + 2,
                    cursor: "pointer",
                    textAlign: "center",
                    fontFamily: t.sans,
                    fontWeight: 800,
                    fontSize: 13.5,
                    background: on ? c + "26" : onDark ? t.raised : t.raised,
                    color: on ? c : t.dim,
                    border: "1.5px solid " + (on ? c : t.line),
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: "13px 14px",
            borderRadius: t.rSm + 2,
            background: onDark ? t.raised : t.raised2,
            border: "1px solid " + t.line,
            display: "flex",
            alignItems: "center",
            gap: 11,
          }}
        >
          <Icon name="pin" size={20} color={QC[4]} />
          <div style={{ flex: 1 }}>
            <Stamp size={9}>Current location</Stamp>
            <div
              style={{
                fontFamily: t.mono,
                fontSize: 12,
                fontWeight: 600,
                marginTop: 3,
              }}
            >
              SS38 · km 47.2 · 46.5285°N 10.4531°E
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <Btn
            accent
            onDark={onDark}
            size="lg"
            onClick={onSubmit}
            icon={<HazardGlyph type={sel} size={19} color="#0E0E10" />}
          >
            Report {HAZARD_TYPES.find((h) => h.id === sel).label.toLowerCase()}
          </Btn>
        </div>
        <div style={{ marginTop: 12, textAlign: "center" }}>
          <Stamp size={10} color={t.mute}>
            +5 km road-data credit · helps the community
          </Stamp>
        </div>
      </Scroll>
    </Screen>
  );
}

Object.assign(window, { RideScreen, CrashScreen, HazardScreen, HazardGlyph });
