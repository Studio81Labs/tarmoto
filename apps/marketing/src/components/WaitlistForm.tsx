import { useState, useEffect } from "react";

interface WaitlistFormProps {
  apiUrl: string;
}

export default function WaitlistForm({ apiUrl }: WaitlistFormProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [count, setCount] = useState<number | null>(null);
  const [errorBorder, setErrorBorder] = useState(false);

  useEffect(() => {
    fetch(`${apiUrl}/count`)
      .then((res) => res.json())
      .then((data) => {
        if (data.count > 0) setCount(data.count);
      })
      .catch(() => {});
  }, [apiUrl]);

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@") || !trimmed.includes(".")) {
      setErrorBorder(true);
      return;
    }
    setErrorBorder(false);
    setStatus("submitting");

    try {
      const res = await fetch(`${apiUrl}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source: "landing_page" }),
      });
      const data = await res.json();
      setStatus("success");
      if (data.count) setCount(data.count);
    } catch {
      setStatus("error");
    }
  }

  const countText =
    count !== null
      ? `${count} rider${count > 1 ? "s" : ""} on the waitlist`
      : "Early access opening soon";

  if (status === "success") {
    return (
      <>
        <div style={styles.success}>
          &#10003; You're on the list! We'll be in touch when the beta is ready.
        </div>
        <div style={styles.count}>
          <span style={styles.countDot} />
          <span>{countText}</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div style={styles.form}>
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setErrorBorder(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="your@email.com"
          style={{
            ...styles.input,
            borderColor: errorBorder
              ? "rgba(239,68,68,.5)"
              : "rgba(255,255,255,.12)",
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={status === "submitting"}
          style={styles.button}
        >
          {status === "submitting" ? "Joining..." : "Join waitlist"}
        </button>
      </div>
      <p style={styles.note}>
        No spam. Unsubscribe anytime. We respect your inbox.
      </p>
      {status === "error" && (
        <p style={{ ...styles.note, color: "var(--red)", marginTop: "8px" }}>
          Something went wrong. Please try again.
        </p>
      )}
      <div style={styles.count}>
        <span style={styles.countDot} />
        <span>{countText}</span>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: {
    display: "flex",
    gap: "10px",
    maxWidth: "440px",
    margin: "0 auto",
  },
  input: {
    flex: 1,
    padding: "14px 18px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,.12)",
    background: "var(--bg2)",
    color: "var(--text)",
    fontFamily: "var(--font)",
    fontSize: "15px",
    outline: "none",
  },
  button: {
    padding: "14px 28px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, var(--cyan), var(--cyan-deep))",
    color: "var(--bg)",
    fontWeight: 700,
    fontSize: "15px",
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--font)",
    whiteSpace: "nowrap",
  },
  note: {
    fontSize: "12px",
    color: "var(--text3)",
    marginTop: "12px",
    textAlign: "center" as const,
  },
  success: {
    padding: "16px",
    borderRadius: "12px",
    background: "rgba(34,197,94,.1)",
    border: "1px solid rgba(34,197,94,.2)",
    color: "var(--green)",
    fontWeight: 600,
    textAlign: "center" as const,
    fontSize: "14px",
    marginTop: "12px",
  },
  count: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 16px",
    borderRadius: "20px",
    background: "rgba(34,197,94,.08)",
    border: "1px solid rgba(34,197,94,.15)",
    fontSize: "13px",
    color: "var(--green)",
    fontWeight: 500,
    marginTop: "24px",
  },
  countDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--green)",
    animation: "pulse 2s infinite",
    display: "inline-block",
  },
};
