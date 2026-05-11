import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

type Status = "idle" | "submitting" | "success" | "error";

interface WaitlistDialogProps {
  apiUrl: string;
}

const OPEN_EVENT = "tarmoto:open-waitlist";

export default function WaitlistDialog({ apiUrl }: WaitlistDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [errorBorder, setErrorBorder] = useState(false);

  const reset = useCallback(() => {
    setEmail("");
    setStatus("idle");
    setErrorBorder(false);
  }, []);

  // Fetch the rider count once for the success state — same contract as
  // the inline form so the dialog can show a consistent number.
  useEffect(() => {
    if (!apiUrl) return;
    fetch(`${apiUrl}/count`)
      .then((res) => res.json())
      .then((data) => {
        if (data.count > 0) setCount(data.count);
      })
      .catch(() => {});
  }, [apiUrl]);

  // Listen for the custom event the nav CTA dispatches.
  useEffect(() => {
    const onOpen = () => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.open) return;
      reset();
      dialog.showModal();
      requestAnimationFrame(() => emailRef.current?.focus());
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [reset]);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) close();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting") return;
    const trimmed = email.trim();
    if (!trimmed.includes("@") || !trimmed.includes(".")) {
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
        body: JSON.stringify({ email: trimmed, source: "nav_dialog" }),
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
  };

  return (
    <dialog
      ref={dialogRef}
      className="waitlist-dialog"
      aria-labelledby={titleId}
      onClick={handleBackdropClick}
    >
      <div className="waitlist-dialog-inner">
        <button
          type="button"
          aria-label="Close"
          className="waitlist-dialog-close"
          onClick={close}
        >
          ×
        </button>

        {status === "success" ? (
          <div className="waitlist-dialog-success">
            <span className="waitlist-dialog-eyebrow">
              You&apos;re on the list
            </span>
            <h2 id={titleId} className="waitlist-dialog-title serif">
              See you on the next loop.
            </h2>
            <p className="waitlist-dialog-body">
              We&apos;ll write once, when your invite is ready. No marketing
              list.
            </p>
            {count !== null && (
              <div className="waitlist-dialog-count">
                <span
                  className="waitlist-dialog-count-dot"
                  aria-hidden="true"
                />
                <span>
                  {count} rider{count > 1 ? "s" : ""} on the waitlist
                </span>
              </div>
            )}
            <button
              type="button"
              className="waitlist-dialog-done"
              onClick={close}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <span className="waitlist-dialog-eyebrow">§ Waitlist</span>
            <h2 id={titleId} className="waitlist-dialog-title serif">
              Join the waitlist.
            </h2>
            <p className="waitlist-dialog-body">
              We&apos;re inviting riders in small batches. Drop your email and
              we&apos;ll write once, when your invite is ready.
            </p>

            <label className="waitlist-dialog-field">
              <span className="waitlist-dialog-field-label">Email</span>
              <input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                placeholder="you@email.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setErrorBorder(false);
                }}
                disabled={status === "submitting"}
                aria-invalid={errorBorder || status === "error"}
                style={
                  errorBorder
                    ? { borderColor: "rgba(176, 71, 58, 0.55)" }
                    : undefined
                }
              />
            </label>

            {status === "error" && (
              <p className="waitlist-dialog-error" role="alert">
                Something went wrong. Please try again in a moment.
              </p>
            )}

            <button
              type="submit"
              className="waitlist-dialog-submit"
              disabled={status === "submitting" || email.trim().length === 0}
            >
              {status === "submitting" ? "Joining…" : "Join the waitlist"}
            </button>

            <p className="waitlist-dialog-note">
              One email when there&apos;s something to share. No marketing list.
            </p>
          </form>
        )}
      </div>
    </dialog>
  );
}
