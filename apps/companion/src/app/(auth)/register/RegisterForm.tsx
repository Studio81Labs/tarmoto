"use client";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@tarmoto/ui";
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
      <h2 className="text-2xl font-bold text-ink mb-2">
        {t("Create your account")}
      </h2>
      <p className="text-ink/60 mb-8">
        {t("Join the Tarmoto rider community")}
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-quality-q1/15 border border-quality-q1/30 text-quality-q1 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-ink/80 mb-1.5">
            {t("Display name")}
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-cream border border-ink/15 text-ink placeholder:text-ink/40 focus:outline-none focus:border-ink focus:ring-1 focus:ring-ink transition"
            placeholder={t("RoadWarrior42")}
            required
          />
        </div>

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
            placeholder={t("Min. 8 characters")}
            minLength={8}
            required
          />
        </div>

        <Button type="submit" variant="primary" block loading={loading}>
          {loading ? t("Creating account...") : t("Create account")}
        </Button>
      </form>

      <OAuthButtons providers={oauthProviders} callbackUrl={callbackUrl} />

      <p className="mt-6 text-center text-sm text-ink/65">
        {t("Already have an account?")}{" "}
        <Link
          href={
            // Mirror of LoginForm — preserves the post-auth
            // destination (e.g. an invite link's /trips/join/...)
            // when the rider hops back to /login.
            searchParams.get("callbackUrl")
              ? `/login?callbackUrl=${encodeURIComponent(searchParams.get("callbackUrl") ?? "")}`
              : "/login"
          }
          className="font-semibold text-ink hover:text-accent hover:underline"
        >
          {t("Sign in")}
        </Link>
      </p>
    </div>
  );
}
