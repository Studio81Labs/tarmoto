# Companion Auth Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate NextAuth.js (Auth.js v5) into the companion app with credentials (email/password) provider against the NestJS backend, plus Google/Apple OAuth providers pre-configured but disabled until the backend supports them.

**Architecture:** Auth.js v5 with the Credentials provider calls the backend's `/api/v1/auth/login` endpoint. The backend's `access_token` and `refresh_token` are stored in the Auth.js JWT session. A custom `authorize` callback handles the backend call; `jwt` and `session` callbacks thread the tokens through. The Axios API client reads the access token from the Auth.js session instead of the Zustand store. Next.js middleware protects dashboard routes. Google and Apple providers are configured but gated behind env vars — they become active once the backend adds OAuth token exchange endpoints.

**Tech Stack:** Auth.js v5 (next-auth@5), Next.js 15 App Router, Zustand (session sync), Axios

**Closes:** GetTarmoto/tarmoto#78

---

## Key Design Decisions

1. **Auth.js manages the session** — it owns token storage, refresh, and cookie management. The Zustand auth store becomes a thin client-side mirror of the Auth.js session for components that need reactive access.

2. **Backend tokens in Auth.js JWT** — the `jwt` callback stores `access_token`, `refresh_token`, and `expires_at` in the Auth.js JWT. The `jwt` callback handles automatic token refresh when `expires_at` is approaching.

3. **Middleware for route protection** — Next.js middleware checks for a valid session and redirects unauthenticated users to `/login`. No more client-side auth guards.

4. **OAuth providers pre-configured** — Google and Apple providers are defined in the auth config but only activate when their env vars (`AUTH_GOOGLE_ID`, `AUTH_APPLE_ID`) are set. The login page shows OAuth buttons conditionally.

5. **Backend response shape** — The backend returns:
   ```json
   {
     "access_token": "jwt...",
     "refresh_token": "jwt...",
     "expires_in": 3600,
     "user": { "id": "uuid", "email": "...", "display_name": "...", "phone": "...", "created_at": "..." }
   }
   ```

---

## File Map

### New files
- `apps/companion/src/lib/auth.ts` — Auth.js configuration (providers, callbacks, pages)
- `apps/companion/src/lib/auth-types.ts` — Type augmentations for Auth.js JWT and Session
- `apps/companion/src/app/api/auth/[...nextauth]/route.ts` — Auth.js route handler
- `apps/companion/src/middleware.ts` — Route protection middleware
- `apps/companion/src/components/AuthSync.tsx` — Syncs Auth.js session → Zustand store
- `apps/companion/src/components/OAuthButtons.tsx` — Google/Apple sign-in buttons (conditional)

### Modified files
- `apps/companion/package.json` — add `next-auth@5` dependency
- `apps/companion/src/stores/auth.ts` — simplify to session mirror (remove localStorage, token management)
- `apps/companion/src/lib/api.ts` — get token from Auth.js session instead of Zustand
- `apps/companion/src/app/layout.tsx` — wrap with SessionProvider + AuthSync
- `apps/companion/src/app/(auth)/layout.tsx` — use Auth.js session for redirect check
- `apps/companion/src/app/(auth)/login/page.tsx` — use `signIn()` from Auth.js, add OAuth buttons
- `apps/companion/src/app/(auth)/register/page.tsx` — register via API then auto-login via `signIn()`
- `apps/companion/src/components/Sidebar.tsx` — use `signOut()` from Auth.js for logout
- `apps/companion/src/components/Topbar.tsx` — read user from Auth.js session
- `apps/companion/.env.local.example` — add auth env vars

---

## Task 1: Install Auth.js and Create Configuration

**Files:**
- Modify: `apps/companion/package.json`
- Create: `apps/companion/src/lib/auth-types.ts`
- Create: `apps/companion/src/lib/auth.ts`
- Create: `apps/companion/src/app/api/auth/[...nextauth]/route.ts`
- Modify: `apps/companion/.env.local.example`

- [ ] **Step 1: Install next-auth v5**

```bash
cd /Users/akadlec/Development/GetTarmoto/tarmoto-companion-auth/apps/companion
pnpm add next-auth@5
```

- [ ] **Step 2: Create Auth.js type augmentations**

Create `apps/companion/src/lib/auth-types.ts`:

```ts
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    id: string;
    email: string;
    displayName: string;
    phone?: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  interface Session {
    user: {
      id: string;
      email: string;
      displayName: string;
      phone?: string;
    };
    accessToken: string;
    error?: "RefreshTokenError";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    email: string;
    displayName: string;
    phone?: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    error?: "RefreshTokenError";
  }
}
```

- [ ] **Step 3: Create Auth.js configuration**

Create `apps/companion/src/lib/auth.ts`:

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import type { NextAuthConfig } from "next-auth";
import "./auth-types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

interface BackendAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    display_name: string;
    phone?: string;
    created_at: string;
  };
}

async function refreshAccessToken(refreshToken: string): Promise<BackendAuthResponse> {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
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
        const res = await fetch(`${API_BASE}/auth/login`, {
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
      // When backend supports OAuth: exchange Google token for Tarmoto JWT
      // profile(profile) { ... }
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
    maxAge: 90 * 24 * 60 * 60, // 90 days — matches backend refresh token
  },
  callbacks: {
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

      // Token still valid — return as-is
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
      session.user = {
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
});
```

- [ ] **Step 4: Create Auth.js route handler**

Create `apps/companion/src/app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 5: Update `.env.local.example`**

Add auth env vars. Read the existing file first to preserve existing content, then add:

```
# Auth.js
AUTH_SECRET=generate-a-random-32-char-string
# AUTH_GOOGLE_ID=your-google-client-id
# AUTH_GOOGLE_SECRET=your-google-client-secret
# AUTH_APPLE_ID=your-apple-client-id
# AUTH_APPLE_SECRET=your-apple-client-secret
```

Google/Apple are commented out — they activate when uncommented.

- [ ] **Step 6: Verify it compiles**

```bash
cd apps/companion && npx tsc --noEmit 2>&1 | head -20
```

Fix any type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/akadlec/Development/GetTarmoto/tarmoto-companion-auth
git add apps/companion/
git commit -m "feat(companion): add Auth.js v5 config with credentials + OAuth providers

Credentials provider calls backend /auth/login.
Google/Apple providers configured but inactive until env vars set.
JWT callback handles automatic token refresh.
Closes #78"
```

---

## Task 2: Middleware for Route Protection

**Files:**
- Create: `apps/companion/src/middleware.ts`

- [ ] **Step 1: Create middleware**

Create `apps/companion/src/middleware.ts`:

```ts
import { auth } from "@/lib/auth";

export default auth((req) => {
  const { nextUrl, auth: session } = req;
  const isAuthenticated = !!session?.user;
  const isAuthPage = nextUrl.pathname.startsWith("/login") ||
    nextUrl.pathname.startsWith("/register") ||
    nextUrl.pathname.startsWith("/forgot-password");
  const isApiRoute = nextUrl.pathname.startsWith("/api");

  // Don't redirect API routes
  if (isApiRoute) return;

  // Redirect authenticated users away from auth pages
  if (isAuthPage && isAuthenticated) {
    return Response.redirect(new URL("/", nextUrl));
  }

  // Redirect unauthenticated users to login
  if (!isAuthPage && !isAuthenticated) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: [
    // Match all routes except static files and _next
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

- [ ] **Step 2: Verify middleware works**

```bash
cd apps/companion && pnpm dev
```

Visit `http://localhost:3000/` — should redirect to `/login`. Visit `/login` — should render login form. Stop dev server.

- [ ] **Step 3: Commit**

```bash
git add apps/companion/src/middleware.ts
git commit -m "feat(companion): add auth middleware for route protection"
```

---

## Task 3: Session Sync and Layout Integration

**Files:**
- Create: `apps/companion/src/components/AuthSync.tsx`
- Modify: `apps/companion/src/stores/auth.ts`
- Modify: `apps/companion/src/app/layout.tsx`
- Modify: `apps/companion/src/app/(auth)/layout.tsx`

- [ ] **Step 1: Simplify the Zustand auth store**

Rewrite `apps/companion/src/stores/auth.ts` — it becomes a thin mirror of Auth.js session, no longer manages tokens or localStorage:

```ts
import { create } from "zustand";

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  phone?: string;
}

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  accessToken: string | null;

  setSession: (user: AuthUser, accessToken: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  accessToken: null,

  setSession: (user, accessToken) =>
    set({ user, isAuthenticated: true, accessToken }),

  clearSession: () =>
    set({ user: null, isAuthenticated: false, accessToken: null }),
}));
```

- [ ] **Step 2: Create AuthSync component**

Create `apps/companion/src/components/AuthSync.tsx` — bridges Auth.js session into Zustand:

```tsx
"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useAuthStore } from "@/stores/auth";
import { signOut } from "next-auth/react";

export function AuthSync() {
  const { data: session, status } = useSession();
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);

  useEffect(() => {
    if (status === "authenticated" && session?.user) {
      setSession(
        {
          id: session.user.id,
          email: session.user.email!,
          displayName: session.user.displayName,
          phone: session.user.phone,
        },
        session.accessToken,
      );

      // If refresh token failed, sign out
      if (session.error === "RefreshTokenError") {
        signOut({ callbackUrl: "/login" });
      }
    } else if (status === "unauthenticated") {
      clearSession();
    }
  }, [session, status, setSession, clearSession]);

  return null;
}
```

- [ ] **Step 3: Update root layout with SessionProvider + AuthSync**

Modify `apps/companion/src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { AuthSync } from "@/components/AuthSync";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Tarmoto",
  description: "Know the road before you ride it",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable}`}>
      <body className="bg-slate-950 text-slate-200 font-sans antialiased">
        <SessionProvider>
          <AuthSync />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Simplify auth layout**

Rewrite `apps/companion/src/app/(auth)/layout.tsx` — middleware now handles the redirect, so no client-side auth check needed:

```tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex bg-slate-950">
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-tarmoto-cyan/10 via-slate-950 to-slate-950" />
        <div className="relative z-10 max-w-md text-center px-8">
          <div className="text-6xl font-extrabold mb-4">
            <span className="text-tarmoto-cyan">T</span>
          </div>
          <h1 className="text-3xl font-bold mb-3">Tarmoto</h1>
          <p className="text-slate-400 text-lg">Know the road before you ride it.</p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
```

Note: this is now a **server component** — no `"use client"` needed since it doesn't use any hooks.

- [ ] **Step 5: Commit**

```bash
git add apps/companion/src/stores/auth.ts apps/companion/src/components/AuthSync.tsx apps/companion/src/app/layout.tsx apps/companion/src/app/\(auth\)/layout.tsx
git commit -m "feat(companion): add session sync and integrate Auth.js into layouts"
```

---

## Task 4: Update API Client to Use Auth.js Token

**Files:**
- Modify: `apps/companion/src/lib/api.ts`

- [ ] **Step 1: Update the Axios request interceptor**

The API client currently reads the token from the Zustand store. Update it to read from the Zustand store (which is now synced from Auth.js session via AuthSync):

```ts
import axios from "axios";
import { useAuthStore } from "@/stores/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

// ── Request interceptor: attach JWT from session ──
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor: handle 401 ──
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Auth.js middleware will handle redirect on next navigation
      useAuthStore.getState().clearSession();
    }
    return Promise.reject(error);
  },
);

// ── Auth endpoints (used by register page — login goes through Auth.js) ──
export const authApi = {
  register: (email: string, password: string, displayName: string) =>
    api.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: { id: string; email: string; display_name: string; phone?: string; created_at: string };
    }>("/auth/register", { email, password, display_name: displayName }),
};

// ── Trip endpoints ──
export const tripsApi = {
  list: (params?: { page?: number; status?: string }) =>
    api.get("/trips", { params }),
  get: (id: string) => api.get(`/trips/${id}`),
  create: (data: any) => api.post("/trips", data),
  update: (id: string, data: any) => api.patch(`/trips/${id}`, data),
  delete: (id: string) => api.delete(`/trips/${id}`),
  generate: (params: any) => api.post("/trips/generate", params),
  invite: (tripId: string, email: string) =>
    api.post(`/trips/${tripId}/invite`, { email }),
};

// ── Road quality endpoints ──
export const roadsApi = {
  getSegment: (id: string) => api.get(`/roads/${id}`),
  search: (params: { bounds: string; quality?: string; surface?: string }) =>
    api.get("/roads/search", { params }),
  getHazards: (bounds: string) =>
    api.get("/roads/hazards", { params: { bounds } }),
  getFunZones: (bounds: string) =>
    api.get("/roads/fun-zones", { params: { bounds } }),
};

// ── Ride endpoints ──
export const ridesApi = {
  list: (params?: { page?: number; sort?: string }) =>
    api.get("/rides", { params }),
  get: (id: string) => api.get(`/rides/${id}`),
  getStats: () => api.get("/rides/stats"),
  getRoadMap: () => api.get("/rides/road-map"),
  export: (id: string, format: "gpx" | "csv") =>
    api.get(`/rides/${id}/export`, { params: { format }, responseType: "blob" }),
};

// ── Community endpoints ──
export const communityApi = {
  feed: (params?: { page?: number; region?: string; sort?: string }) =>
    api.get("/community/feed", { params }),
  getProfile: (riderId: string) => api.get(`/riders/${riderId}`),
  follow: (riderId: string) => api.post(`/riders/${riderId}/follow`),
  unfollow: (riderId: string) => api.delete(`/riders/${riderId}/follow`),
  getCollections: (params?: { page?: number }) =>
    api.get("/community/collections", { params }),
  submitReview: (segmentId: string, data: { rating: number; text: string }) =>
    api.post(`/roads/${segmentId}/reviews`, data),
};

// ── Account endpoints ──
export const accountApi = {
  updateProfile: (data: any) => api.patch("/account/profile", data),
  getSubscription: () => api.get("/account/subscription"),
  getBikes: () => api.get("/account/bikes"),
  addBike: (data: any) => api.post("/account/bikes", data),
  updateBike: (id: string, data: any) => api.patch(`/account/bikes/${id}`, data),
  deleteBike: (id: string) => api.delete(`/account/bikes/${id}`),
  exportData: () => api.post("/account/export"),
  deleteAccount: () => api.delete("/account"),
};
```

Key changes:
- Token now comes from `useAuthStore.getState().accessToken` (synced from Auth.js)
- 401 handler clears session rather than doing `window.location.href` redirect
- `authApi` simplified — only `register` remains (login goes through Auth.js `signIn()`)
- Register endpoint now matches backend's snake_case field name (`display_name`)

- [ ] **Step 2: Commit**

```bash
git add apps/companion/src/lib/api.ts
git commit -m "feat(companion): update API client to use Auth.js session token"
```

---

## Task 5: Update Auth Pages (Login, Register) and Components (Sidebar, Topbar)

**Files:**
- Create: `apps/companion/src/components/OAuthButtons.tsx`
- Modify: `apps/companion/src/app/(auth)/login/page.tsx`
- Modify: `apps/companion/src/app/(auth)/register/page.tsx`
- Modify: `apps/companion/src/components/Sidebar.tsx`
- Modify: `apps/companion/src/components/Topbar.tsx`

- [ ] **Step 1: Create OAuth buttons component**

Create `apps/companion/src/components/OAuthButtons.tsx`:

```tsx
"use client";

import { signIn } from "next-auth/react";

// These buttons only render when the OAuth providers are configured.
// The providers list is fetched from Auth.js at runtime.

export function OAuthButtons({ providers }: { providers: string[] }) {
  if (providers.length === 0) return null;

  return (
    <>
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-slate-700" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-slate-950 px-4 text-slate-500">or continue with</span>
        </div>
      </div>

      <div className="space-y-3">
        {providers.includes("google") && (
          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg border border-slate-700 bg-slate-800 text-white hover:bg-slate-700 transition"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Continue with Google
          </button>
        )}

        {providers.includes("apple") && (
          <button
            onClick={() => signIn("apple", { callbackUrl: "/" })}
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg border border-slate-700 bg-slate-800 text-white hover:bg-slate-700 transition"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
            Continue with Apple
          </button>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Rewrite login page**

Rewrite `apps/companion/src/app/(auth)/login/page.tsx` to use Auth.js `signIn()`:

```tsx
"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { OAuthButtons } from "@/components/OAuthButtons";

// OAuth providers available (empty until env vars are set)
const oauthProviders: string[] = [
  ...(process.env.NEXT_PUBLIC_HAS_GOOGLE === "true" ? ["google"] : []),
  ...(process.env.NEXT_PUBLIC_HAS_APPLE === "true" ? ["apple"] : []),
];

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid email or password");
      setLoading(false);
    } else {
      window.location.href = callbackUrl;
    }
  };

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold mb-2">Welcome back</h2>
      <p className="text-slate-400 mb-8">Sign in to your Tarmoto account</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="rider@example.com"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="••••••••"
            required
          />
        </div>

        <div className="flex items-center justify-end text-sm">
          <Link href="/forgot-password" className="text-tarmoto-cyan hover:underline">
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>

      <OAuthButtons providers={oauthProviders} />

      <p className="mt-6 text-center text-sm text-slate-400">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-tarmoto-cyan hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite register page**

Rewrite `apps/companion/src/app/(auth)/register/page.tsx` — register via API, then auto-login via `signIn()`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { authApi } from "@/lib/api";

export default function RegisterPage() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Register with backend
      await authApi.register(email, password, displayName);

      // Auto-login after successful registration
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Account created but login failed. Please sign in manually.");
      } else {
        window.location.href = "/";
      }
    } catch (err: any) {
      setError(err.response?.data?.message ?? "Registration failed");
      setLoading(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold mb-2">Create your account</h2>
      <p className="text-slate-400 mb-8">Join the Tarmoto rider community</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="RoadWarrior42"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="rider@example.com"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:outline-none focus:border-tarmoto-cyan focus:ring-1 focus:ring-tarmoto-cyan transition"
            placeholder="Min. 8 characters"
            minLength={8}
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-tarmoto-cyan text-slate-950 font-semibold hover:bg-tarmoto-cyan-light disabled:opacity-50 transition"
        >
          {loading ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        Already have an account?{" "}
        <Link href="/login" className="text-tarmoto-cyan hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Update Sidebar logout**

In `apps/companion/src/components/Sidebar.tsx`, replace the Zustand-based logout with Auth.js `signOut()`:

Change the imports — remove `useAuthStore`, add `signOut`:
```ts
import { signOut } from "next-auth/react";
```

Replace the logout handler:
```ts
const handleLogout = () => {
  signOut({ callbackUrl: "/login" });
};
```

Remove the `useAuthStore` logout import/usage from this component.

- [ ] **Step 5: Update Topbar**

In `apps/companion/src/components/Topbar.tsx`, replace Zustand user read with Auth.js session:

```tsx
"use client";

import { Bell } from "lucide-react";
import { useSession } from "next-auth/react";

export function Topbar() {
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6">
      <div />
      <div className="flex items-center gap-4">
        <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
          <Bell size={18} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-tarmoto-cyan rounded-full" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-tarmoto-cyan/20 flex items-center justify-center text-tarmoto-cyan text-sm font-bold">
            {user?.displayName?.[0]?.toUpperCase() ?? "T"}
          </div>
          {user?.displayName && (
            <span className="text-sm font-medium text-slate-300">{user.displayName}</span>
          )}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 6: Verify the full auth flow**

```bash
cd apps/companion && pnpm dev
```

1. Visit `/` — should redirect to `/login`
2. Login form renders with email/password fields
3. No OAuth buttons visible (env vars not set)
4. Register link works, navigates to `/register`
5. Forgot password link works
6. After form submit (will fail without backend running, but the signIn flow should fire)

Stop dev server.

- [ ] **Step 7: Verify build**

```bash
pnpm build
```

Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/companion/src/
git commit -m "feat(companion): wire auth pages, sidebar, topbar to Auth.js

Login uses signIn(), register calls API then auto-signs in.
Sidebar/Topbar read from Auth.js session.
OAuth buttons conditionally rendered when providers configured."
```

---

## Task 6: Build Verification and Final Cleanup

**Files:**
- Possibly fix type or build errors across the companion app

- [ ] **Step 1: Full typecheck**

```bash
cd /Users/akadlec/Development/GetTarmoto/tarmoto-companion-auth/apps/companion
npx tsc --noEmit
```

Fix any remaining type errors (especially around Auth.js type augmentations).

- [ ] **Step 2: Full build**

```bash
pnpm build
```

Expected: Build succeeds with all routes compiled.

- [ ] **Step 3: Generate AUTH_SECRET for .env.local**

Create `apps/companion/.env.local` with a generated secret:

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" > apps/companion/.env.local
echo "NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1" >> apps/companion/.env.local
echo "NEXT_PUBLIC_WS_URL=http://localhost:3000" >> apps/companion/.env.local
```

This file is gitignored.

- [ ] **Step 4: Verify dev server starts clean**

```bash
pnpm dev
```

Confirm no console errors. Stop dev server.

- [ ] **Step 5: Commit any fixes**

If any fixes were needed:
```bash
git add -A
git commit -m "fix(companion): resolve auth integration type and build issues"
```
