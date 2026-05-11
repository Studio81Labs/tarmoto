import { useState, useEffect } from "react";

interface WaitlistFormProps {
  apiUrl: string;
  stage?: "waitlist" | "beta" | "launch";
}

export default function WaitlistForm({
  apiUrl,
  stage = "waitlist",
}: WaitlistFormProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [count, setCount] = useState<number | null>(null);
  const [errorBorder, setErrorBorder] = useState(false);

  useEffect(() => {
    if (!apiUrl) return;
    fetch(`${apiUrl}/count`)
      .then((res) => res.json())
      .then((data) => {
        if (data.count > 0) setCount(data.count);
      })
      .catch(() => {});
  }, [apiUrl]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@") || !trimmed.includes(".")) {
      setErrorBorder(true);
      return;
    }
    setErrorBorder(false);
    setStatus("submitting");

    if (!apiUrl) {
      setStatus("success");
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source: "landing_page" }),
      });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const data = await res.json();
      setStatus("success");
      if (data.count) setCount(data.count);
    } catch {
      setStatus("error");
    }
  }

  const submitLabel =
    status === "submitting"
      ? "Joining..."
      : stage === "launch"
        ? "Get Tarmoto"
        : stage === "beta"
          ? "Request invite"
          : "Join the waitlist";

  if (status === "success") {
    return (
      <div style={styles.successWrap}>
        <div style={styles.successBox}>
          <span style={styles.successCheck}>✓</span>
          <div>
            <div style={styles.successTitle}>You're on the list.</div>
            <div style={styles.successNote}>
              We'll write once, when your invite is ready.
            </div>
          </div>
        </div>
        {count !== null && (
          <div style={styles.count}>
            <span style={styles.countDot} />
            <span>
              {count} rider{count > 1 ? "s" : ""} on the waitlist
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <form
        onSubmit={handleSubmit}
        style={{
          ...styles.form,
          borderColor: errorBorder
            ? "rgba(176,71,58,0.5)"
            : "rgba(232,229,222,0.16)",
        }}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setErrorBorder(false);
          }}
          placeholder="you@email.com"
          style={styles.input}
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          style={styles.button}
        >
          {submitLabel}
        </button>
      </form>
      <p style={styles.note}>
        One email when there's something to share. No marketing list.
      </p>
      {status === "error" && (
        <p style={{ ...styles.note, color: "#B0473A", marginTop: "8px" }}>
          Something went wrong. Please try again.
        </p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: "520px",
    width: "100%",
  },
  form: {
    display: "flex",
    gap: "6px",
    padding: "5px",
    borderRadius: "10px",
    background: "var(--panel-2)",
    border: "1px solid var(--line-2)",
  },
  input: {
    flex: 1,
    minWidth: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    padding: "11px 12px",
    fontSize: "14px",
    fontFamily: "var(--font)",
    color: "var(--text)",
  },
  button: {
    border: "none",
    cursor: "pointer",
    padding: "11px 18px",
    borderRadius: "7px",
    background:
      "linear-gradient(180deg, var(--accent-soft) 0%, var(--accent) 55%, var(--accent-deep) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 18px -8px rgba(217,79,8,0.55)",
    color: "var(--bg)",
    fontWeight: 600,
    fontSize: "13.5px",
    fontFamily: "var(--font)",
    whiteSpace: "nowrap",
  },
  note: {
    fontSize: "12px",
    color: "var(--mute)",
    marginTop: "10px",
  },
  successWrap: {
    maxWidth: "520px",
    width: "100%",
  },
  successBox: {
    padding: "16px 18px",
    borderRadius: "10px",
    background: "var(--panel-2)",
    border: "1px solid var(--line-2)",
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  successCheck: {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    background: "var(--accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--bg)",
    fontWeight: 700,
    fontSize: "14px",
    flexShrink: 0,
  },
  successTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--text)",
  },
  successNote: {
    fontSize: "12px",
    color: "var(--mute)",
    marginTop: "2px",
  },
  count: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 14px",
    borderRadius: "999px",
    background: "rgba(77,182,172,0.07)",
    border: "1px solid rgba(77,182,172,0.20)",
    fontSize: "12px",
    color: "var(--sync)",
    fontWeight: 500,
    marginTop: "16px",
  },
  countDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--sync)",
    boxShadow: "0 0 8px 0 rgba(77,182,172,0.55)",
    animation: "pulse 2s infinite",
    display: "inline-block",
  },
};
