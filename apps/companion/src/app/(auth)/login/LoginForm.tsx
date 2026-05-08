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
      <h2 className="text-2xl font-bold mb-2">{t("Welcome back")}</h2>
      <p className="text-slate-400 mb-8">
        {t("Sign in to your Tarmoto account")}
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            {t("Email")}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder={t("rider@example.com")}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            {t("Password")}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="••••••••"
            required
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-slate-400">
            <input
              type="checkbox"
              className="rounded border-slate-600 bg-slate-800 text-tarmoto-cyan focus:ring-tarmoto-cyan"
            />
            {t("Remember me")}
          </label>
          <Link
            href="/forgot-password"
            className="text-tarmoto-cyan hover:underline"
          >
            {t("Forgot password?")}
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {loading ? t("Signing in...") : t("Sign in")}
        </button>
      </form>

      <OAuthButtons providers={oauthProviders} callbackUrl={callbackUrl} />

      <p className="mt-6 text-center text-sm text-slate-400">
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
          className="text-tarmoto-cyan hover:underline"
        >
          {t("Create one")}
        </Link>
      </p>
    </div>
  );
}
