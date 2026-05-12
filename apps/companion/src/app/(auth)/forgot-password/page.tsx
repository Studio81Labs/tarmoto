"use client";
import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/i18n/I18nProvider";
import { forgotPassword } from "@/lib/api";
export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await forgotPassword(email);
    } catch {
      // Ignore errors — show success regardless to prevent email enumeration
    } finally {
      setSent(true);
      setLoading(false);
    }
  };
  if (sent) {
    return (
      <div className="animate-fade-in text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-accent/20 flex items-center justify-center text-ink text-2xl">
          ✓
        </div>
        <h2 className="text-2xl font-bold text-ink mb-2">
          {t("Check your email")}
        </h2>
        <p className="text-ink/65 mb-8">
          {t(
            "If an account exists for {email}, we've sent a password reset link.",
            { email },
          )}
        </p>
        <Link
          href="/login"
          className="text-sm font-semibold text-ink hover:text-accent hover:underline"
        >
          {t("Back to sign in")}
        </Link>
      </div>
    );
  }
  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold text-ink mb-2">
        {t("Reset password")}
      </h2>
      <p className="text-ink/60 mb-8">
        {t("Enter your email and we'll send a reset link")}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-ink/80 mb-1.5">
            {t("Email")}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-cream border border-ink/15 text-ink placeholder:text-ink/40 focus:outline-none focus:border-ink focus:ring-1 focus:ring-ink transition"
            placeholder={t("rider@example.com")}
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-ink text-cream font-semibold hover:bg-tarmac disabled:opacity-50 transition"
        >
          {loading ? t("Sending...") : t("Send reset link")}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink/65">
        <Link
          href="/login"
          className="font-semibold text-ink hover:text-accent hover:underline"
        >
          {t("Back to sign in")}
        </Link>
      </p>
    </div>
  );
}
