"use client";
import { getUserFacingErrorMessage } from "@/i18n";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button, FieldLabel, Input, PasswordInput } from "@tarmoto/ui";
import { useI18n } from "@/i18n/I18nProvider";
import { OAuthButtons } from "@/components/OAuthButtons";
import { registerUser } from "@/lib/api";
import { safeCallbackUrl } from "@/lib/callback-url";
import { DASHBOARD_PATH, PLAN_STEP_PATH } from "@/lib/onboarding";
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
  // Where a brand-new rider lands (#1173). The test is what the callback
  // RESOLVES to, not whether the param was present: `middleware.ts` mints
  // `callbackUrl=/` for any logged-out visit to `/` and `LoginForm` forwards it
  // to `/register`, so a present-but-root callback is the most common case of
  // all and means "nowhere in particular" — exactly like an absent,
  // cross-origin or malformed one, which `safeCallbackUrl` also resolves to
  // `/`. All of them get the plan step.
  //
  // A REAL destination is preserved: a rider who arrived from a trip invite or
  // a shared ride came for that, and the step is skippable and permanently
  // reachable at /settings/subscription — hijacking an invite link to sell a
  // plan would be the worse trade.
  //
  // Credentials registration only. `OAuthButtons` below still uses
  // `callbackUrl`: neither NextAuth nor the backend's social sign-in reports
  // whether an account was CREATED (`AuthResponseDto` carries no new-user
  // flag), so routing OAuth here would show a pricing step to every returning
  // rider who signs in from this page.
  const postRegisterUrl =
    callbackUrl === DASHBOARD_PATH ? PLAN_STEP_PATH : callbackUrl;
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await registerUser(email, password, displayName, t);
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError(t("Account created but sign-in failed. Please log in."));
      } else {
        window.location.href = postRegisterUrl;
      }
    } catch (err: unknown) {
      setError(getUserFacingErrorMessage(err, t("Registration failed")));
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
          <FieldLabel htmlFor="register-name">{t("Display name")}</FieldLabel>
          <Input
            id="register-name"
            type="text"
            value={displayName}
            onChange={setDisplayName}
            tone="cream"
            placeholder={t("RoadWarrior42")}
            required
          />
        </div>

        <div>
          <FieldLabel htmlFor="register-email">{t("Email")}</FieldLabel>
          <Input
            id="register-email"
            type="email"
            value={email}
            onChange={setEmail}
            tone="cream"
            placeholder={t("rider@example.com")}
            required
          />
        </div>

        <div>
          <FieldLabel htmlFor="register-password">{t("Password")}</FieldLabel>
          <PasswordInput
            id="register-password"
            value={password}
            onChange={setPassword}
            tone="cream"
            placeholder={t(
              "Min. {count, plural, one {# character} other {# characters}}",
              { count: 8 },
            )}
            autoComplete="new-password"
            showStrength
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
          {t("Already have an account? Sign in")}
        </Link>
      </p>
    </div>
  );
}
