"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  Button,
  Checkbox,
  FieldLabel,
  Input,
  PasswordInput,
} from "@tarmoto/ui";
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
  // Cosmetic for now — the credentials flow doesn't vary session length —
  // but the control needs state to render as the shared Checkbox.
  const [rememberMe, setRememberMe] = useState(false);
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
          <FieldLabel htmlFor="login-email">{t("Email")}</FieldLabel>
          <Input
            id="login-email"
            type="email"
            value={email}
            onChange={setEmail}
            tone="cream"
            placeholder={t("rider@example.com")}
            required
          />
        </div>

        <div>
          <FieldLabel htmlFor="login-password">{t("Password")}</FieldLabel>
          <PasswordInput
            id="login-password"
            value={password}
            onChange={setPassword}
            tone="cream"
            placeholder="••••••••"
            required
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <Checkbox
            checked={rememberMe}
            onChange={setRememberMe}
            label={t("Remember me")}
          />
          <Link
            href="/forgot-password"
            className="font-semibold text-ink/70 hover:text-accent hover:underline"
          >
            {t("Forgot password?")}
          </Link>
        </div>

        <Button type="submit" variant="primary" block loading={loading}>
          {loading ? t("Signing in...") : t("Sign in")}
        </Button>
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
