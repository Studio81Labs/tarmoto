// Tweaks panel — slides up from bottom when toggled on by the toolbar.

function Tweaks({ visible, state, setState }) {
  const s = state;
  const Row = ({ label, children }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 0",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        gap: 12,
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: "rgba(245,239,230,0.55)",
          letterSpacing: 1,
          textTransform: "uppercase",
          fontWeight: 600,
          flexShrink: 0,
          minWidth: 90,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {children}
      </div>
    </div>
  );
  const Btn = ({ active, onClick, children }) => (
    <button
      onClick={onClick}
      style={{
        padding: "6px 10px",
        borderRadius: 8,
        fontSize: 11,
        fontFamily: "'Space Grotesk', system-ui",
        fontWeight: 700,
        border: active
          ? "1.5px solid #FF6A1A"
          : "1px solid rgba(255,255,255,0.12)",
        background: active ? "rgba(255,106,26,0.15)" : "rgba(255,255,255,0.04)",
        color: active ? "#FF6A1A" : "#F5EFE6",
        cursor: "pointer",
        transition: "all 120ms",
      }}
    >
      {children}
    </button>
  );

  const set = (k) => (v) => {
    const next = { ...s, [k]: v };
    setState(next);
    try {
      window.parent.postMessage(
        { type: "__edit_mode_set_keys", edits: { [k]: v } },
        "*",
      );
    } catch {}
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        width: 320,
        transform: visible
          ? "translateY(0) scale(1)"
          : "translateY(20px) scale(0.95)",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "all 240ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: "rgba(14,14,16,0.95)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 20,
          padding: "14px 16px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          color: "#F5EFE6",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontFamily: "'Space Grotesk', system-ui",
              fontWeight: 800,
              fontSize: 14,
              letterSpacing: -0.2,
            }}
          >
            Tweaks
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "rgba(245,239,230,0.4)",
              letterSpacing: 1,
            }}
          >
            TARMOTO · RIDE
          </div>
        </div>

        <Row label="HUD">
          <Btn
            active={s.variant === "classic"}
            onClick={() => set("variant")("classic")}
          >
            Classic
          </Btn>
          <Btn
            active={s.variant === "instrument"}
            onClick={() => set("variant")("instrument")}
          >
            Instrument
          </Btn>
          <Btn
            active={s.variant === "minimal"}
            onClick={() => set("variant")("minimal")}
          >
            Minimal
          </Btn>
        </Row>
        <Row label="Theme">
          <Btn
            active={s.theme === "light"}
            onClick={() => set("theme")("light")}
          >
            Light
          </Btn>
          <Btn active={s.theme === "dark"} onClick={() => set("theme")("dark")}>
            Dark
          </Btn>
          <Btn active={s.theme === "oled"} onClick={() => set("theme")("oled")}>
            OLED
          </Btn>
        </Row>
        <Row label="Density">
          <Btn
            active={s.density === "compact"}
            onClick={() => set("density")("compact")}
          >
            Compact
          </Btn>
          <Btn
            active={s.density === "comfortable"}
            onClick={() => set("density")("comfortable")}
          >
            Comfortable
          </Btn>
        </Row>
        <Row label="Map">
          <Btn
            active={s.mapStyle === "heatmap"}
            onClick={() => set("mapStyle")("heatmap")}
          >
            Heatmap
          </Btn>
          <Btn
            active={s.mapStyle === "topo"}
            onClick={() => set("mapStyle")("topo")}
          >
            Topo
          </Btn>
          <Btn
            active={s.mapStyle === "hybrid"}
            onClick={() => set("mapStyle")("hybrid")}
          >
            Hybrid
          </Btn>
        </Row>
        <Row label="Min quality">
          {[1, 2, 3, 4, 5].map((n) => (
            <Btn
              key={n}
              active={s.qualityMin === n}
              onClick={() => set("qualityMin")(n)}
            >
              {["VP", "PR", "FR", "GD", "EX"][n - 1]}
            </Btn>
          ))}
        </Row>
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            lineHeight: 1.5,
            color: "rgba(245,239,230,0.35)",
            letterSpacing: 0.3,
          }}
        >
          Tap the rider dot on the map to jump around the route. The hazard
          alert triggers automatically as you approach poor tarmac sections.
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Tweaks });
