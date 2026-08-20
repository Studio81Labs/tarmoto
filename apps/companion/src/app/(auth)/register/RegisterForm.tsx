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
import { PLAN_STEP_PATH } from "@/lib/onboarding";
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
  const requestedCallbackUrl = searchParams.get("callbackUrl");
  const callbackUrl = safeCallbackUrl(requestedCallbackUrl);
  // Where a brand-new rider lands (#1173). A rider who arrived WITH a
  // `callbackUrl` came for something specific — a trip invite, a shared ride —
  // so they keep going there; the plan step is skippable and reachable later at
  // /settings/subscription, and hijacking an invite link to sell a plan would
  // be the worse trade. Only the default `/` destination becomes the step.
  //
  // Credentials registration only. `OAuthButtons` below still uses
  // `callbackUrl`: neither NextAuth nor the backend's social sign-in reports
  // whether an account was CREATED (`AuthResponseDto` carries no new-user
  // flag), so routing OAuth here would show a pricing step to every returning
  // rider who signs in from this page.
  const postRegisterUrl = requestedCallbackUrl ? callbackUrl : PLAN_STEP_PATH;
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
