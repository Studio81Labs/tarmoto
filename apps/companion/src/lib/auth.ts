import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import type { NextAuthConfig } from "next-auth";
import "./auth-types";

import { API_BASE_SERVER } from "@/lib/config";
import {
  exchangeOAuthUserForBackendTokens,
  type BackendAuthResponse,
} from "@/lib/social-auth-bridge";
import {
  SOCIAL_ACCOUNT_CONFLICT_ERROR,
  SOCIAL_ACCOUNT_CONFLICT_MESSAGE,
  SOCIAL_SIGNIN_FAILED_ERROR,
} from "@/lib/auth-errors";

async function refreshAccessToken(
  refreshToken: string,
): Promise<BackendAuthResponse> {
  const res = await fetch(`${API_BASE_SERVER}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) throw new Error("Token refresh failed");
  return res.json();
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
        const res = await fetch(`${API_BASE_SERVER}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
          }),
        });

        if (!res.ok) return null;

        const data: BackendAuthResponse = await res.json();

        return {
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.display_name,
          phone: data.user.phone,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        };
      } catch {
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
        const data = await exchangeOAuthUserForBackendTokens({
          email: user.email,
          displayName: user.name ?? null,
        });

        Object.assign(user, {
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.display_name,
          phone: data.user.phone,
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
          phone: user.phone,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          expiresAt: user.expiresAt,
        };
      }

      // Token still valid — return as-is (with 60s buffer)
      if (Date.now() / 1000 < token.expiresAt - 60) {
        return token;
      }

      // Token expired — attempt refresh
      try {
        const data = await refreshAccessToken(token.refreshToken);
        return {
          ...token,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
          error: undefined,
        };
      } catch {
        return { ...token, error: "RefreshTokenError" as const };
      }
    },

    async session({ session, token }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).user = {
        id: token.id,
        email: token.email,
        displayName: token.displayName,
        phone: token.phone,
      };
      session.accessToken = token.accessToken;
      if (token.error) session.error = token.error;
      return session;
    },
  },
  secret: process.env.AUTH_SECRET,
  trustHost: true,
});
