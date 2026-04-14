# Tarmoto Dashboard

> User-facing web companion at `dash.tarmoto.app` — plan rides, explore road quality, track your riding life.

## Prerequisites

- Node.js 20+
- npm or pnpm

## Setup

```bash
npm install
cp .env.example .env.local    # fill in API URL, map tiles, Stripe key
npm run dev                   # http://localhost:3000
```

## Build & Deploy

```bash
npm run build      # outputs to dist/
npm run preview    # preview production build
```

Deploy `dist/` to Cloudflare Pages with custom domain `dash.tarmoto.app`.

## Project Structure

```
dashboard/
├── index.html                     Entry HTML
├── vite.config.ts                 Vite config (proxy, aliases)
├── tailwind.config.ts             Tailwind with Tarmoto brand tokens
├── tsconfig.json                  TypeScript strict mode
├── .env.example                   Environment variables
│
└── src/
    ├── main.tsx                   React entry point
    ├── App.tsx                    Route configuration
    │
    ├── layouts/
    │   ├── DashboardLayout.tsx    Sidebar nav + top bar + content area
    │   └── AuthLayout.tsx         Split layout for login/register
    │
    ├── pages/
    │   ├── HomePage.tsx           Dashboard with quick actions
    │   ├── auth/
    │   │   ├── LoginPage.tsx
    │   │   ├── RegisterPage.tsx
    │   │   └── ForgotPasswordPage.tsx
    │   ├── trips/
    │   │   ├── TripPlannerPage.tsx    ★ Flagship — full-screen map planner
    │   │   ├── TripListPage.tsx
    │   │   └── TripDetailPage.tsx
    │   ├── explorer/
    │   │   └── ExplorerPage.tsx       Road quality heatmap explorer
    │   ├── rides/
    │   │   ├── RideListPage.tsx
    │   │   ├── RideDetailPage.tsx
    │   │   ├── StatsPage.tsx
    │   │   └── RoadMapPage.tsx        Personal ridden-vs-unridden map
    │   ├── community/
    │   │   ├── CommunityFeedPage.tsx
    │   │   ├── ProfilePage.tsx
    │   │   └── RouteCollectionsPage.tsx
    │   └── settings/
    │       ├── AccountPage.tsx
    │       ├── SubscriptionPage.tsx
    │       ├── PrivacyPage.tsx
    │       ├── BikesPage.tsx
    │       └── NotificationsPage.tsx
    │
    ├── services/
    │   ├── api.ts                 Axios client with JWT interceptors
    │   └── socket.ts             Socket.io for collaboration + hazard alerts
    │
    ├── stores/
    │   ├── authStore.ts           Auth state + JWT management
    │   ├── mapStore.ts            Map center, zoom, overlay filters
    │   └── tripStore.ts           Active trip, waypoints, days
    │
    ├── hooks/
    │   └── index.ts               useApi, useDebounce, useWindowSize, etc.
    │
    ├── types/
    │   └── index.ts               All TypeScript types (mirrors backend schema)
    │
    ├── utils/
    │   └── index.ts               Quality helpers, formatters, hazard config
    │
    ├── styles/
    │   └── globals.css            Tailwind directives, MapLibre CSS, glass effects
    │
    ├── components/                Reusable UI components (to be built)
    │   └── (empty — ready for extraction)
    │
    └── assets/                    Static assets
        └── (empty)
```

## Architecture Decisions

**Vite + React SPA** — not Next.js. The dashboard is a fully authenticated app behind login — no SSR needed, no SEO crawling. Vite gives faster HMR, simpler mental model, no server/client component confusion.

**Shared NestJS backend** — same API endpoints serve mobile and web. JWT auth is cross-platform. No BFF layer.

**Zustand stores** — same library as the React Native mobile app. Store patterns are intentionally similar for developer familiarity.

**MapLibre GL JS** — same tile format and styling as MapLibre GL Native on mobile. Road quality heatmap is the same vector tile layer.

**Tailwind CSS** — brand tokens (tarmoto-cyan, quality colors, surface colors) defined in `tailwind.config.ts`. Glass panel effect via `glass` utility class.

## Key Integration Points

| Feature | Backend Endpoint | Real-time |
|---------|-----------------|-----------|
| Trip planner | `POST /trips/generate`, `PATCH /trips/:id` | WebSocket cursor sync |
| Road explorer | `GET /roads/search?bounds=...` | Hazard alert feed |
| Ride history | `GET /rides`, `GET /rides/:id` | — |
| Community | `GET /community/feed` | — |
| Auth | `POST /auth/login`, `POST /auth/register` | — |
| Payments | Stripe Checkout + Webhooks | — |

## Deployment

Hosted on **Cloudflare Pages** at `dash.tarmoto.app`.

```bash
# Connect to Cloudflare Pages
# Build command: npm run build
# Output directory: dist
# Custom domain: dash.tarmoto.app
```

## Related

- `GetTarmoto/tarmoto/app/` — React Native mobile app
- `GetTarmoto/web/` — Marketing site at `tarmoto.app`
- `GetTarmoto/tarmoto/docs/` — PRD, schema, architecture docs
