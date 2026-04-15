# Companion App — Next.js Scaffold & Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a Next.js companion app at `apps/companion`, migrate all production-ready code from `apps/dashboard` (Vite+React), then delete the old dashboard.

**Architecture:** Next.js 15 with App Router, Tailwind CSS 4, TypeScript strict. Zustand stores, Axios API client, and Socket.io client migrate directly (framework-agnostic). React Router layouts convert to Next.js route groups and layouts. Pages convert to App Router file conventions. Auth will use NextAuth.js (issue #78) but for now we scaffold middleware-based auth guard matching the existing pattern.

**Tech Stack:** Next.js 15, React 19, TypeScript 5, Tailwind CSS 4, Zustand, Axios, Socket.io-client, Lucide React, clsx, MapLibre GL, Recharts

**Closes:** GetTarmoto/tarmoto#77

**Source:** `apps/dashboard/` (Vite+React, to be deleted after migration)

---

## File Map

### Root changes
- Modify: `package.json` — update scripts (dashboard → companion)
- Modify: `pnpm-workspace.yaml` — no change needed (already includes `apps/*`)

### `apps/companion/` (create)

```
apps/companion/
├── package.json
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── .env.local.example
├── public/
│   └── favicon.svg
├── src/
│   ├── app/
│   │   ├── layout.tsx                    ← root layout (fonts, globals)
│   │   ├── globals.css                   ← Tailwind + custom styles
│   │   ├── (auth)/
│   │   │   ├── layout.tsx                ← auth split-screen layout
│   │   │   ├── login/page.tsx
│   │   │   ├── register/page.tsx
│   │   │   └── forgot-password/page.tsx
│   │   └── (dashboard)/
│   │       ├── layout.tsx                ← sidebar + topbar layout
│   │       ├── page.tsx                  ← home
│   │       ├── explore/page.tsx
│   │       ├── trips/
│   │       │   ├── page.tsx              ← trip list
│   │       │   ├── [tripId]/page.tsx     ← trip detail
│   │       │   └── planner/page.tsx      ← trip planner
│   │       ├── rides/
│   │       │   ├── page.tsx              ← ride list
│   │       │   ├── [rideId]/page.tsx     ← ride detail
│   │       │   ├── stats/page.tsx
│   │       │   └── road-map/page.tsx
│   │       ├── community/
│   │       │   ├── page.tsx              ← feed
│   │       │   ├── [riderId]/page.tsx    ← profile
│   │       │   └── collections/page.tsx
│   │       └── settings/
│   │           ├── page.tsx              ← account
│   │           ├── bikes/page.tsx
│   │           ├── notifications/page.tsx
│   │           ├── privacy/page.tsx
│   │           └── subscription/page.tsx
│   ├── components/
│   │   ├── Sidebar.tsx                   ← extracted from DashboardLayout
│   │   └── Topbar.tsx                    ← extracted from DashboardLayout
│   ├── lib/
│   │   ├── types.ts                      ← migrated from dashboard types/index.ts
│   │   ├── utils.ts                      ← migrated from dashboard utils/index.ts
│   │   ├── api.ts                        ← migrated, env var changed to NEXT_PUBLIC_API_URL
│   │   └── socket.ts                     ← migrated, env var changed to NEXT_PUBLIC_WS_URL
│   ├── stores/
│   │   ├── auth.ts                       ← migrated from authStore.ts
│   │   ├── trip.ts                       ← migrated from tripStore.ts
│   │   └── map.ts                        ← migrated from mapStore.ts
│   └── hooks/
│       └── index.ts                      ← migrated, useApi adapted for client components
```

### `apps/dashboard/` (delete in final task)

---

## Task 1: Scaffold Next.js App

**Files:**
- Create: `apps/companion/package.json`
- Create: `apps/companion/next.config.ts`
- Create: `apps/companion/tsconfig.json`
- Create: `apps/companion/postcss.config.mjs`
- Create: `apps/companion/.env.local.example`
- Create: `apps/companion/src/app/globals.css`
- Create: `apps/companion/src/app/layout.tsx`
- Create: `apps/companion/src/app/(dashboard)/page.tsx`
- Modify: root `package.json` — replace dashboard scripts with companion

- [ ] **Step 1: Create `apps/companion/package.json`**

```json
{
  "name": "@tarmoto/companion",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "axios": "^1.7.0",
    "socket.io-client": "^4.8.0",
    "clsx": "^2.1.0",
    "lucide-react": "^0.460.0",
    "maplibre-gl": "^4.7.0",
    "react-map-gl": "^7.1.0",
    "recharts": "^2.13.0",
    "date-fns": "^4.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/geojson": "^7946.0.16",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `apps/companion/next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@tarmoto/shared"],
};

export default nextConfig;
```

- [ ] **Step 3: Create `apps/companion/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `apps/companion/postcss.config.mjs`**

```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 5: Create `apps/companion/.env.local.example`**

```
NEXT_PUBLIC_API_URL=http://localhost:3000/api
NEXT_PUBLIC_WS_URL=http://localhost:3000
```

- [ ] **Step 6: Create `apps/companion/src/app/globals.css`**

Migrate from `apps/dashboard/src/styles/globals.css`. Adapt for Tailwind v4 (CSS-based config, `@import "tailwindcss"` instead of directives):

```css
@import "tailwindcss";

/* MapLibre GL CSS */
@import "maplibre-gl/dist/maplibre-gl.css";

/* ── Tarmoto theme ── */
@theme {
  --color-tarmoto-cyan: #0ED3CF;
  --color-tarmoto-cyan-light: #5DE5E2;
  --color-tarmoto-cyan-dark: #0AA8A5;

  --color-quality-excellent: #22C55E;
  --color-quality-good: #84CC16;
  --color-quality-fair: #EAB308;
  --color-quality-poor: #F97316;
  --color-quality-very-poor: #EF4444;

  --color-surface-asphalt: #3B82F6;
  --color-surface-concrete: #6B7280;
  --color-surface-cobblestone: #A78BFA;
  --color-surface-gravel: #D97706;
  --color-surface-dirt: #92400E;

  --color-slate-850: #172033;
  --color-slate-950: #0B1120;

  --font-sans: "Plus Jakarta Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;

  --animate-fade-in: fadeIn 0.3s ease-out;
  --animate-slide-up: slideUp 0.3s ease-out;
  --animate-slide-in-right: slideInRight 0.3s ease-out;
  --animate-pulse-slow: pulse 3s ease-in-out infinite;

  @keyframes fadeIn {
    0% { opacity: 0; }
    100% { opacity: 1; }
  }

  @keyframes slideUp {
    0% { opacity: 0; transform: translateY(10px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  @keyframes slideInRight {
    0% { opacity: 0; transform: translateX(20px); }
    100% { opacity: 1; transform: translateX(0); }
  }
}

/* ── Base styles ── */
@layer base {
  html {
    scroll-behavior: smooth;
  }

  body {
    min-height: 100vh;
  }

  ::-webkit-scrollbar {
    width: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--color-slate-700, #334155);
    border-radius: 9999px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: var(--color-slate-600, #475569);
  }
}

/* ── Component utilities ── */
@layer components {
  .quality-excellent { background: color-mix(in srgb, var(--color-quality-excellent) 20%, transparent); color: var(--color-quality-excellent); }
  .quality-good { background: color-mix(in srgb, var(--color-quality-good) 20%, transparent); color: var(--color-quality-good); }
  .quality-fair { background: color-mix(in srgb, var(--color-quality-fair) 20%, transparent); color: var(--color-quality-fair); }
  .quality-poor { background: color-mix(in srgb, var(--color-quality-poor) 20%, transparent); color: var(--color-quality-poor); }
  .quality-very-poor { background: color-mix(in srgb, var(--color-quality-very-poor) 20%, transparent); color: var(--color-quality-very-poor); }

  .glass {
    background: color-mix(in srgb, var(--color-slate-900, #0f172a) 80%, transparent);
    backdrop-filter: blur(24px);
    border: 1px solid color-mix(in srgb, var(--color-slate-700, #334155) 50%, transparent);
  }

  .map-panel {
    @apply glass;
    border-radius: 1rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
  }
}
```

- [ ] **Step 7: Create `apps/companion/src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
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
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 8: Create minimal home page for verification**

Create `apps/companion/src/app/(dashboard)/page.tsx`:

```tsx
export default function HomePage() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <h1 className="text-2xl font-bold">
        <span className="text-tarmoto-cyan">T</span>armoto Companion
      </h1>
    </div>
  );
}
```

- [ ] **Step 9: Copy favicon**

```bash
cp apps/dashboard/public/favicon.svg apps/companion/public/favicon.svg 2>/dev/null || echo "No favicon to copy"
```

If no favicon exists in dashboard, copy from the web repo or create `apps/companion/public/` as empty.

- [ ] **Step 10: Update root `package.json`**

Replace `dev:dashboard` and `build:dashboard` with companion scripts:
- `"dev:companion": "pnpm --filter @tarmoto/companion dev"`
- `"build:companion": "pnpm --filter @tarmoto/companion build"`

Remove the old `dev:dashboard` and `build:dashboard` entries.

- [ ] **Step 11: Install and verify**

```bash
cd /Users/akadlec/Development/GetTarmoto/tarmoto
pnpm install
cd apps/companion && pnpm dev
```

Expected: Next.js dev server starts, page renders at `http://localhost:3000` with "Tarmoto Companion" text in cyan. Stop the dev server.

- [ ] **Step 12: Commit**

```bash
git add apps/companion/ package.json
git commit -m "scaffold Next.js companion app (replaces dashboard)

Closes #77"
```

---

## Task 2: Migrate Lib Layer (types, utils, api, socket)

**Files:**
- Create: `apps/companion/src/lib/types.ts`
- Create: `apps/companion/src/lib/utils.ts`
- Create: `apps/companion/src/lib/api.ts`
- Create: `apps/companion/src/lib/socket.ts`

These files are framework-agnostic and migrate with minimal changes.

- [ ] **Step 1: Copy and adapt types**

Copy `apps/dashboard/src/types/index.ts` to `apps/companion/src/lib/types.ts`. No changes needed — pure TypeScript interfaces.

- [ ] **Step 2: Copy and adapt utils**

Copy `apps/dashboard/src/utils/index.ts` to `apps/companion/src/lib/utils.ts`.

Change the import path:
```ts
// Before:
import type { QualityTier, HazardType } from '@/types';
// After:
import type { QualityTier, HazardType } from '@/lib/types';
```

- [ ] **Step 3: Copy and adapt API client**

Copy `apps/dashboard/src/services/api.ts` to `apps/companion/src/lib/api.ts`.

Changes:
1. Import path: `@/stores/authStore` → `@/stores/auth`
2. Env var: `import.meta.env.VITE_API_URL` → `process.env.NEXT_PUBLIC_API_URL`

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';
```

Rest of the file (interceptors, all endpoint objects) stays identical.

- [ ] **Step 4: Copy and adapt socket client**

Copy `apps/dashboard/src/services/socket.ts` to `apps/companion/src/lib/socket.ts`.

Changes:
1. Import path: `@/stores/authStore` → `@/stores/auth`
2. Env var: `import.meta.env.VITE_WS_URL` → `process.env.NEXT_PUBLIC_WS_URL`

```ts
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';
```

- [ ] **Step 5: Verify imports resolve**

```bash
cd apps/companion && npx tsc --noEmit 2>&1 | head -20
```

Fix any import path issues. Some type errors may appear from missing store files — that's expected until Task 3.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/lib/
git commit -m "migrate lib layer: types, utils, api client, socket client"
```

---

## Task 3: Migrate Stores and Hooks

**Files:**
- Create: `apps/companion/src/stores/auth.ts`
- Create: `apps/companion/src/stores/trip.ts`
- Create: `apps/companion/src/stores/map.ts`
- Create: `apps/companion/src/hooks/index.ts`

- [ ] **Step 1: Copy and adapt auth store**

Copy `apps/dashboard/src/stores/authStore.ts` to `apps/companion/src/stores/auth.ts`.

Change: `import type { User } from '@/types'` → `import type { User } from '@/lib/types'`

The `localStorage` usage requires this to be a client-only module. That's fine — Zustand stores are always client-side.

- [ ] **Step 2: Copy and adapt trip store**

Copy `apps/dashboard/src/stores/tripStore.ts` to `apps/companion/src/stores/trip.ts`.

Change: `import type { Trip, Waypoint } from '@/types'` → `import type { Trip, Waypoint } from '@/lib/types'`

- [ ] **Step 3: Copy and adapt map store**

Copy `apps/dashboard/src/stores/mapStore.ts` to `apps/companion/src/stores/map.ts`.

No import changes needed (no external type imports).

- [ ] **Step 4: Copy and adapt hooks**

Copy `apps/dashboard/src/hooks/index.ts` to `apps/companion/src/hooks/index.ts`.

Change: `import { api } from '@/services/api'` → `import { api } from '@/lib/api'`

All hooks use browser APIs (`window`, `localStorage`, `document`) so they are client-only. Components using them must be `"use client"`.

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/companion && npx tsc --noEmit
```

Expected: Clean or only errors from missing page files referencing stores.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/stores/ apps/companion/src/hooks/
git commit -m "migrate Zustand stores and React hooks"
```

---

## Task 4: Migrate Layouts (Auth + Dashboard)

**Files:**
- Create: `apps/companion/src/app/(auth)/layout.tsx`
- Create: `apps/companion/src/components/Sidebar.tsx`
- Create: `apps/companion/src/components/Topbar.tsx`
- Create: `apps/companion/src/app/(dashboard)/layout.tsx`

The key adaptation: React Router's `<Outlet />` becomes Next.js's `{children}` prop. `<NavLink>` becomes `next/link` + `usePathname()` for active states. `useNavigate()` becomes `useRouter()`.

- [ ] **Step 1: Create auth layout**

Create `apps/companion/src/app/(auth)/layout.tsx`. Adapt from `apps/dashboard/src/layouts/AuthLayout.tsx`:

- Replace `Outlet` with `{children}`
- Replace `Navigate` from react-router with `redirect` from `next/navigation`
- Add `"use client"` directive (uses Zustand store)
- Replace `useAuthStore` redirect logic with the same pattern but using `redirect()`

```tsx
"use client";

import { useAuthStore } from "@/stores/auth";
import { redirect } from "next/navigation";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isAuthenticated) redirect("/");

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

- [ ] **Step 2: Extract Sidebar component**

Create `apps/companion/src/components/Sidebar.tsx`. Extract from `DashboardLayout.tsx`:

- Replace `NavLink` from react-router with `Link` from `next/link` + `usePathname()` for active detection
- Replace `useNavigate` with `useRouter` from `next/navigation`
- Keep the `NAV_SECTIONS` config, lucide icons, collapse logic, logout button

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import {
  Home, Map, Route, History, BarChart3, Users, Settings, Bike,
  LogOut, ChevronLeft, ChevronRight,
} from "lucide-react";
import clsx from "clsx";

const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      { href: "/", icon: Home, label: "Home" },
      { href: "/explore", icon: Map, label: "Road Explorer" },
    ],
  },
  {
    label: "Planning",
    items: [
      { href: "/trips", icon: Route, label: "Trips" },
    ],
  },
  {
    label: "Riding",
    items: [
      { href: "/rides", icon: History, label: "Ride History" },
      { href: "/rides/stats", icon: BarChart3, label: "Statistics" },
      { href: "/rides/road-map", icon: Map, label: "My Road Map" },
    ],
  },
  {
    label: "Community",
    items: [
      { href: "/community", icon: Users, label: "Community" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/settings", icon: Settings, label: "Settings" },
      { href: "/settings/bikes", icon: Bike, label: "My Bikes" },
    ],
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside
      className={clsx(
        "flex flex-col border-r border-slate-800 bg-slate-950 transition-all duration-300",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex h-16 items-center justify-between px-4 border-b border-slate-800">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight">
            <span className="text-tarmoto-cyan">T</span>armoto
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-6">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            {!collapsed && (
              <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                    isActive(item.href)
                      ? "bg-tarmoto-cyan/10 text-tarmoto-cyan"
                      : "text-slate-400 hover:text-white hover:bg-slate-800/60",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <item.icon size={18} />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-800 p-3">
        <button
          onClick={handleLogout}
          className={clsx(
            "flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-red-400 hover:bg-red-400/5 transition",
            collapsed && "justify-center px-0",
          )}
        >
          <LogOut size={18} />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Extract Topbar component**

Create `apps/companion/src/components/Topbar.tsx`:

```tsx
"use client";

import { useAuthStore } from "@/stores/auth";
import { Bell } from "lucide-react";

export function Topbar() {
  const user = useAuthStore((s) => s.user);

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

- [ ] **Step 4: Create dashboard layout**

Create `apps/companion/src/app/(dashboard)/layout.tsx`:

```tsx
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar />
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Verify dev server**

```bash
cd apps/companion && pnpm dev
```

Expected: Home page renders with sidebar, topbar, and "Tarmoto Companion" content area. Sidebar nav links work. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/app/\(auth\)/ apps/companion/src/app/\(dashboard\)/layout.tsx apps/companion/src/components/
git commit -m "migrate layouts: auth split-screen, dashboard sidebar + topbar"
```

---

## Task 5: Migrate Auth Pages

**Files:**
- Create: `apps/companion/src/app/(auth)/login/page.tsx`
- Create: `apps/companion/src/app/(auth)/register/page.tsx`
- Create: `apps/companion/src/app/(auth)/forgot-password/page.tsx`

Adapt each page from `apps/dashboard/src/pages/auth/`:
- Add `"use client"` directive
- Replace `useNavigate()` with `useRouter()` from `next/navigation`
- Replace `Link` from react-router with `Link` from `next/link`
- Import paths: `@/stores/authStore` → `@/stores/auth`, `@/services/api` → `@/lib/api`

- [ ] **Step 1: Migrate login page**

Read `apps/dashboard/src/pages/auth/LoginPage.tsx` and create `apps/companion/src/app/(auth)/login/page.tsx` with the adaptations listed above. Keep all form logic, validation, error handling, and styling identical.

- [ ] **Step 2: Migrate register page**

Read `apps/dashboard/src/pages/auth/RegisterPage.tsx` and create `apps/companion/src/app/(auth)/register/page.tsx` with the same adaptations.

- [ ] **Step 3: Migrate forgot password page**

Read `apps/dashboard/src/pages/auth/ForgotPasswordPage.tsx` and create `apps/companion/src/app/(auth)/forgot-password/page.tsx` with the same adaptations.

- [ ] **Step 4: Verify auth flow**

```bash
cd apps/companion && pnpm dev
```

Visit `http://localhost:3000/login`. Expected: Login form renders with email/password fields, link to register and forgot password. Navigate between auth pages. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/companion/src/app/\(auth\)/
git commit -m "migrate auth pages: login, register, forgot password"
```

---

## Task 6: Migrate Dashboard Pages (Home, Explorer, Trips, Rides)

**Files:**
- Modify: `apps/companion/src/app/(dashboard)/page.tsx` (replace test content)
- Create: `apps/companion/src/app/(dashboard)/explore/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/trips/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/trips/[tripId]/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/[rideId]/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/stats/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/road-map/page.tsx`

For ALL pages, apply these adaptations:
- Add `"use client"` directive (all use hooks, stores, or browser APIs)
- Replace react-router imports: `useNavigate` → `useRouter`, `useParams` → `useParams` from `next/navigation`, `Link` → `next/link`
- Import paths: `@/types` → `@/lib/types`, `@/utils` → `@/lib/utils`, `@/services/api` → `@/lib/api`, `@/stores/*Store` → `@/stores/*`

- [ ] **Step 1: Migrate home page**

Read `apps/dashboard/src/pages/HomePage.tsx`. Replace the test content in `apps/companion/src/app/(dashboard)/page.tsx` with the adapted version. Convert `Link` from react-router to `next/link`.

- [ ] **Step 2: Migrate explorer page**

Read `apps/dashboard/src/pages/explorer/ExplorerPage.tsx`. Create `apps/companion/src/app/(dashboard)/explore/page.tsx`. This has map placeholder — that's fine, it'll be wired up in a future issue.

- [ ] **Step 3: Migrate trip pages (list, detail, planner)**

Read each of:
- `apps/dashboard/src/pages/trips/TripListPage.tsx` → `trips/page.tsx`
- `apps/dashboard/src/pages/trips/TripDetailPage.tsx` → `trips/[tripId]/page.tsx` (use `useParams()` from next/navigation)
- `apps/dashboard/src/pages/trips/TripPlannerPage.tsx` → `trips/planner/page.tsx`

- [ ] **Step 4: Migrate ride pages (list, detail, stats, road-map)**

Read each of:
- `apps/dashboard/src/pages/rides/RideListPage.tsx` → `rides/page.tsx`
- `apps/dashboard/src/pages/rides/RideDetailPage.tsx` → `rides/[rideId]/page.tsx`
- `apps/dashboard/src/pages/rides/StatsPage.tsx` → `rides/stats/page.tsx`
- `apps/dashboard/src/pages/rides/RoadMapPage.tsx` → `rides/road-map/page.tsx`

- [ ] **Step 5: Verify all routes render**

```bash
cd apps/companion && pnpm dev
```

Click through all sidebar nav items. Each page should render without errors. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/
git commit -m "migrate dashboard pages: home, explorer, trips, rides"
```

---

## Task 7: Migrate Community and Settings Pages

**Files:**
- Create: `apps/companion/src/app/(dashboard)/community/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/community/[riderId]/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/community/collections/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/settings/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/settings/bikes/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/settings/notifications/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/settings/privacy/page.tsx`
- Create: `apps/companion/src/app/(dashboard)/settings/subscription/page.tsx`

Same adaptation pattern as Task 6.

- [ ] **Step 1: Migrate community pages**

Read each from `apps/dashboard/src/pages/community/` and create the Next.js equivalents. Same adaptations (use client, next/link, next/navigation, updated import paths).

- [ ] **Step 2: Migrate settings pages**

Read each from `apps/dashboard/src/pages/settings/` and create the Next.js equivalents. The settings account page has a navigation menu to sub-pages — convert react-router `Link` to `next/link`.

Fix the NotificationsPage: replace the `querySelector` hack for toggle state with proper React `useState`.

- [ ] **Step 3: Verify all routes**

```bash
cd apps/companion && pnpm dev
```

Click through community and settings pages. All should render. Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/community/ apps/companion/src/app/\(dashboard\)/settings/
git commit -m "migrate community and settings pages"
```

---

## Task 8: Build Verification, Cleanup, Delete Dashboard

**Files:**
- Delete: `apps/dashboard/` (entire directory)
- Modify: root `package.json` (remove any remaining dashboard references)

- [ ] **Step 1: Verify full build**

```bash
cd /Users/akadlec/Development/GetTarmoto/tarmoto
pnpm install
cd apps/companion && pnpm build
```

Expected: Next.js builds successfully. Fix any type errors.

- [ ] **Step 2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 3: Delete old dashboard**

```bash
rm -rf apps/dashboard
```

- [ ] **Step 4: Clean up root package.json**

Remove any remaining `dashboard` references from scripts. Ensure only `companion` scripts remain. Run `pnpm install` to update the lockfile.

- [ ] **Step 5: Verify the whole monorepo still works**

```bash
pnpm install
cd apps/companion && pnpm dev
```

Expected: Companion dev server starts, all pages render. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "remove apps/dashboard, replaced by apps/companion

All production-ready code migrated to Next.js 15 with App Router.
Dashboard layout, auth pages, settings, trips, rides, community,
and all lib code (types, utils, stores, api, socket) preserved."
```

---

## Task 9: Update Issue Labels and Close

- [ ] **Step 1: Update platform label**

Update the `platform:web` label description from "Web companion app (Next.js)" to "Web companion app (React/Next.js)" (or leave as-is since Next.js is correct now).

- [ ] **Step 2: Close issue #77**

The companion app is scaffolded and all dashboard code is migrated.

```bash
gh issue close 77 --repo GetTarmoto/tarmoto --comment "Companion app scaffolded at apps/companion using Next.js 15 with App Router. All code from apps/dashboard migrated and dashboard deleted."
```

- [ ] **Step 3: Update remaining web issues**

Update issues #78-82 if they reference "dashboard" or "Next.js scaffold" to reflect the new `apps/companion` location.
