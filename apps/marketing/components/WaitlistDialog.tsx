"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";

type Status = "idle" | "submitting" | "success" | "error";

const ENDPOINT = "/api/waitlist";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function WaitlistDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset to a fresh form state every time the dialog is reopened.
  const reset = useCallback(() => {
    setEmail("");
    setStatus("idle");
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      reset();
      dialog.showModal();
      requestAnimationFrame(() => emailRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, reset]);

  // Native dialogs fire `close` on Escape — propagate to parent state.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onNativeClose = () => onClose();
    dialog.addEventListener("close", onNativeClose);
    return () => dialog.removeEventListener("close", onNativeClose);
  }, [onClose]);

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting") return;

    setStatus("submitting");
    setErrorMessage(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!response.ok) {
        const data = await safeJson(response);
        throw new Error(data?.error ?? `request_failed_${response.status}`);
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(toUserMessage(err));
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
          onClick={onClose}
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
            <button
              type="button"
              className="waitlist-dialog-done"
              onClick={onClose}
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
                onChange={(e) => setEmail(e.target.value)}
                disabled={status === "submitting"}
              />
            </label>

            {errorMessage ? (
              <p className="waitlist-dialog-error" role="alert">
                {errorMessage}
              </p>
            ) : null}

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

async function safeJson(
  response: Response,
): Promise<{ error?: string } | null> {
  try {
    return (await response.json()) as { error?: string };
  } catch {
    return null;
  }
}

function toUserMessage(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "invalid_email":
      return "That email doesn’t look right — please double-check it.";
    case "payload_too_large":
      return "That submission is too large. Try a shorter email.";
    case "waitlist_kv_not_configured":
      return "We’re still wiring up the waitlist. Please try again soon.";
    default:
      return "Something went wrong on our end. Please try again in a moment.";
  }
}
