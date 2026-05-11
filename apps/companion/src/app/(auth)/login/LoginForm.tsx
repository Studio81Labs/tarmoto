"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useI18n } from "@/i18n/I18nProvider";
import { OAuthButtons } from "@/components/OAuthButtons";
import { safeCallbackUrl } from "@/lib/callback-url";
import { getLoginErrorMessage } from "@/lib/auth-errors";
import type { OAuthProvider } from "@/lib/oauth-providers";
export function LoginForm({
  oauthProviders,
}: {
  oauthProviders: OAuthProvider[];
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const urlError = getLoginErrorMessage(searchParams.get("error"));
  const [error, setError] = useState(urlError);
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  useEffect(() => {
    setError(urlError);
  }, [urlError]);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError("Invalid email or password");
      } else {
        window.location.href = callbackUrl;
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold text-ink mb-2">{t("Welcome back")}</h2>
      <p className="text-ink/60 mb-8">{t("Sign in to your Tarmoto account")}</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-quality-q1/15 border border-quality-q1/30 text-quality-q1 text-sm">
          {error}
        </div>
      )}

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

        <div>
          <label className="block text-sm font-semibold text-ink/80 mb-1.5">
            {t("Password")}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-cream border border-ink/15 text-ink placeholder:text-ink/40 focus:outline-none focus:border-ink focus:ring-1 focus:ring-ink transition"
            placeholder="••••••••"
            required
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-ink/65">
            <input
              type="checkbox"
              className="rounded border-ink/30 bg-cream text-accent focus:ring-accent"
            />
            {t("Remember me")}
          </label>
          <Link
            href="/forgot-password"
            className="font-semibold text-ink/70 hover:text-accent hover:underline"
          >
            {t("Forgot password?")}
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-ink text-cream font-semibold hover:bg-tarmac disabled:opacity-50 transition"
        >
          {loading ? t("Signing in...") : t("Sign in")}
        </button>
      </form>

      <OAuthButtons providers={oauthProviders} callbackUrl={callbackUrl} />

      <p className="mt-6 text-center text-sm text-ink/65">
        {t("Don't have an account?")}{" "}
        <Link
          href={
            // Forward the post-auth destination to /register so an
            // unauthenticated invitee following a /trips/join/...
            // email link doesn't lose the invite when they realise
            // they need to sign up first. `callbackUrl` is already
            // origin-validated by `safeCallbackUrl` upstream, but we
            // pass the raw search-param value (not the resolved one)
            // so the same value flows through both auth pages
            // unchanged.
            searchParams.get("callbackUrl")
              ? `/register?callbackUrl=${encodeURIComponent(searchParams.get("callbackUrl") ?? "")}`
              : "/register"
          }
          className="font-semibold text-ink hover:text-accent hover:underline"
        >
          {t("Create one")}
        </Link>
      </p>
    </div>
  );
}
