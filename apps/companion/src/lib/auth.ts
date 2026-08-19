import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import type { NextAuthConfig } from "next-auth";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  matchSupportedLocale,
  resolveLocale,
  type SupportedLocale,
} from "@tarmoto/shared";
import "./auth-types";

import { apiServer } from "@/lib/api/server";
import { exchangeOAuthUserForBackendTokens } from "@/lib/social-auth-bridge";
import { applyRefreshResult, dedupedRefresh } from "@/lib/auth-refresh";
import {
  SOCIAL_ACCOUNT_CONFLICT_ERROR,
  SOCIAL_ACCOUNT_CONFLICT_MESSAGE,
  SOCIAL_SIGNIN_FAILED_ERROR,
} from "@/lib/auth-errors";
import { LOCALE_COOKIE } from "@/i18n/constants";

async function resolveAuthRequestLocale(): Promise<SupportedLocale> {
  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    const resolved = value ? matchSupportedLocale(value) : undefined;
    if (resolved) return resolved;
  } catch {
    // Auth callbacks can also run in contexts without request cookies.
  }

  try {
    return resolveLocale((await headers()).get("accept-language"));
  } catch {
    return DEFAULT_LOCALE;
  }
}

const providers: NextAuthConfig["providers"] = [
  Credentials({
    id: "credentials",
    name: "Email",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null;

      try {
        const { data, response } = await apiServer.POST("/api/v1/auth/login", {
          body: {
            email: credentials.email as string,
            password: credentials.password as string,
          },
        });

        if (!response.ok || !data) {
          // 401 is the ordinary wrong-credentials answer — stay quiet.
          // Anything else (backend down, wrong API origin, a proxy in the
          // way) must say so in the server log: returning a bare null here
          // reduces every failure mode to the same indistinguishable
          // CredentialsSignin, which is exactly what made the first Coolify
          // login failure undiagnosable. Never log the credentials.
          if (response.status !== 401) {
            console.error(
              `[auth] credentials login failed: backend replied ${response.status} ${response.statusText}`,
            );
          }
          return null;
        }

        return {
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.display_name,
          language: data.user.language,
          // `UserResponseDto.phone` is `string | null`; the NextAuth `User`
          // models an absent phone as `undefined`.
          phone: data.user.phone ?? undefined,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        };
      } catch (error) {
        // The request never got an HTTP answer — DNS, TLS, egress, or a
        // dead backend. Surface the cause; the thrown detail never
        // contains the submitted credentials.
        console.error(
          "[auth] credentials login failed before reaching the backend:",
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    },
  }),
];

// Add Google provider if configured
if (process.env.AUTH_GOOGLE_ID) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  );
}

// Add Apple provider if configured
if (process.env.AUTH_APPLE_ID) {
  providers.push(
    Apple({
      clientId: process.env.AUTH_APPLE_ID,
      clientSecret: process.env.AUTH_APPLE_SECRET!,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  pages: {
    signIn: "/login",
    newUser: "/register",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 90 * 24 * 60 * 60,
  },
  callbacks: {
    async signIn({ user, account }) {
      if (!account || account.provider === "credentials") return true;

      try {
        const data = await exchangeOAuthUserForBackendTokens(
          {
            email: user.email,
            displayName: user.name ?? null,
          },
          { locale: await resolveAuthRequestLocale() },
        );

        Object.assign(user, {
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.display_name,
          language: data.user.language,
          phone: data.user.phone ?? undefined,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        });

        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === SOCIAL_ACCOUNT_CONFLICT_MESSAGE
        ) {
          return `/login?error=${SOCIAL_ACCOUNT_CONFLICT_ERROR}`;
        }

        return `/login?error=${SOCIAL_SIGNIN_FAILED_ERROR}`;
      }
    },

    async jwt({ token, user }) {
      // Initial sign-in — store backend tokens
      if (user) {
        return {
          ...token,
          id: user.id,
          email: user.email!,
          displayName: user.displayName,
          language: user.language,
          phone: user.phone,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          expiresAt: user.expiresAt,
        };
      }

      // Token still valid — return as-is (with 5 min buffer). The
      // buffer is intentionally larger than the SessionProvider
      // `refetchInterval` (4 min) so the next poll always catches an
      // about-to-expire token and rotates it before any API call sees
      // an expired bearer.
      if (Date.now() / 1000 < token.expiresAt - 5 * 60) {
        return token;
      }

      // Token expired — attempt refresh (deduped per refresh-token
      // so concurrent tabs in the same session share one backend
      // round-trip, but two independent sessions for the same
      // rider remain isolated).
      try {
        const data = await dedupedRefresh(token.refreshToken);
        return applyRefreshResult(token, data);
      } catch {
        // If the access token is still technically valid (we entered
        // this branch because of the 5 min refresh buffer, not because
        // the token already expired), a transient backend hiccup —
        // 429, a rotated refresh token, or a brief network blip —
        // shouldn't bounce the user to /login. Keep the existing
        // token and let the next 4 min poll retry. Only surface
        // `RefreshTokenError` once the access token is genuinely
        // past its expiry, where the user can no longer make API
        // calls anyway.
        if (Date.now() / 1000 < token.expiresAt) {
          return token;
        }
        return { ...token, error: "RefreshTokenError" as const };
      }
    },

    async session({ session, token }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).user = {
        id: token.id,
        email: token.email,
        displayName: token.displayName,
        language: token.language,
        phone: token.phone,
      };
      session.accessToken = token.accessToken;
      if (token.error) session.error = token.error;
      return session;
    },
  },
  ...(process.env.AUTH_SECRET !== undefined
    ? { secret: process.env.AUTH_SECRET }
    : {}),
  trustHost: true,
});
