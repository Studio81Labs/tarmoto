"use client";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useI18n } from "@/i18n/I18nProvider";
import { OAuthButtons } from "@/components/OAuthButtons";
import { registerUser } from "@/lib/api";
import { safeCallbackUrl } from "@/lib/callback-url";
import type { OAuthProvider } from "@/lib/oauth-providers";
export function RegisterForm({
  oauthProviders,
}: {
  oauthProviders: OAuthProvider[];
}) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await registerUser(email, password, displayName);
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError("Account created but sign-in failed. Please log in.");
      } else {
        window.location.href = callbackUrl;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold mb-2">{t("Create your account")}</h2>
      <p className="text-slate-400 mb-8">
        {t("Join the Tarmoto rider community")}
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            {t("Display name")}
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder={t("RoadWarrior42")}
            required
          />
        </div>

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
            placeholder={t("Min. 8 characters")}
            minLength={8}
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {loading ? t("Creating account...") : t("Create account")}
        </button>
      </form>

      <OAuthButtons providers={oauthProviders} callbackUrl={callbackUrl} />

      <p className="mt-6 text-center text-sm text-slate-400">
        {t("Already have an account?")}{" "}
        <Link href="/login" className="text-tarmoto-cyan hover:underline">
          {t("Sign in")}
        </Link>
      </p>
    </div>
  );
}
