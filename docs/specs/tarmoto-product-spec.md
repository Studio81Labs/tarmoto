# TARMOTO — Product Requirements Document

> **Know the road before you ride it.**

Version 1.1 | April 2026 | CONFIDENTIAL

| Field           | Value                                        |
| --------------- | -------------------------------------------- |
| Document Status | Draft                                        |
| Author          | Product Team                                 |
| Last Updated    | April 14, 2026                               |
| Target Platform | iOS & Android (React Native) + Web (Next.js) |
| Target Launch   | Q1 2027 (MVP — Mobile + Web)                 |

---

## 1. Product Vision

Tarmoto is a next-generation motorcycle companion app that solves the biggest unsolved problem in moto navigation: road surface quality. While existing apps like Calimoto, Kurviger, and Scenic compete on finding curvy roads, none of them tell riders whether those roads are actually good to ride on.

Tarmoto combines crowdsourced road surface intelligence (using smartphone accelerometers), real-time safety alerts, and an innovative multi-day trip planner that eliminates the hours riders currently spend manually checking roads via Street View and aerial photos.

### 1.1 Problem Statement

Motorcycle riders face three critical unmet needs:

- **Road surface quality is invisible** — apps route riders onto bumpy, potholed, or gravel roads without warning, creating safety hazards and ruining rides.
- **Multi-day trip planning is painfully manual** — groups spend hours scrolling Street View and aerial photos to verify road conditions before committing to a route.
- **No app serves the daily commuter AND weekend rider** — existing apps are built for touring, ignoring the 80% of riding that is commuting.

### 1.2 Target Users

| Persona          | Description                                                   | Primary Need                                             |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Daily Commuter   | Rides to work 5 days/week, wants the safest and fastest route | Real-time hazard alerts, road quality on commute routes  |
| Weekend Explorer | Rides for fun on weekends, looking for great roads nearby     | Fun-factor road discovery, surface quality assurance     |
| Touring Group    | Plans multi-day trips with friends, needs collaborative tools | Multi-day trip builder, road preview, group coordination |
| Adventure Rider  | Off-road and mixed-terrain, needs surface type information    | Surface type classification (asphalt/gravel/dirt)        |

### 1.3 Unique Value Proposition

> **_"Know the road before you ride it."_** Tarmoto is the only motorcycle app that tells you how good the actual asphalt is, not just how curvy the road looks on a map.

---

## 2. Competitive Analysis

The motorcycle app market has several established players, each with distinct strengths but a common blind spot: none address road surface quality or provide real-time rider safety intelligence.

| Feature                       | Calimoto     | Kurviger             | Scenic       | REVER | Tarmoto      |
| ----------------------------- | ------------ | -------------------- | ------------ | ----- | ------------ |
| Curvy road routing            | ✓            | ✓                    | ✓            | ✓     | ✓            |
| **Road surface quality**      | ✗            | ✗                    | ✗            | ✗     | **✓**        |
| **Real-time hazard alerts**   | ✗            | ✗                    | ✗            | ✗     | **✓**        |
| **Multi-day trip AI builder** | Limited      | Web only             | ✗            | ✗     | **✓**        |
| **Road preview cards**        | ✗            | ✗                    | ✗            | ✗     | **✓**        |
| **Collaborative planning**    | ✗            | ✗                    | ✗            | Basic | **✓**        |
| Crash detection               | ✗            | ✗                    | ✗            | ✗     | **✓**        |
| CarPlay + Android Auto        | CarPlay only | AA only              | ✗            | ✗     | **Both**     |
| Commuter mode                 | ✗            | ✗                    | ✗            | ✗     | **✓**        |
| **Web companion app**         | ✗            | **✓** (planner only) | ✗            | Basic | **✓ (full)** |
| Offline maps                  | ✓ (paid)     | ✓ (paid)             | ✓            | ✗     | ✓            |
| Social / community            | Basic        | Forum                | ✗            | ✓     | ✓            |
| Pricing                       | $60/yr       | $30/yr               | $25 lifetime | Free+ | Freemium     |

---

## 3. Epics & Feature Breakdown

The product is organized into 7 epics, each representing a major capability area. Epics are prioritized by business impact and technical dependency.

### 3.1 EPIC 1: Road Surface Intelligence (Killer Feature)

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

Every rider using Tarmoto passively collects road surface quality data via smartphone accelerometers. The app measures vibration patterns and classifies road segments into quality tiers. Over time, this builds a proprietary database of road conditions that no competitor can replicate.

**User Stories:**

- ✅ **US-1:** As a rider, I want to see a road quality overlay on the map so that I can avoid roads with poor asphalt before I ride them.
- ✅ **US-2:** As a rider, I want my phone to automatically record road surface data while I ride so that I contribute to the community without any extra effort.
- ✅ **US-3:** As a rider, I want to see a Road Quality Score (1–5) for each road segment so that I can quickly assess if a road is worth riding.
- ✅ **US-4:** As a rider, I want to report specific hazards (pothole, gravel, oil spill) with a single tap so that other riders are warned immediately.
- ✅ **US-5:** As a route planner, I want to filter routes by minimum road quality so that I only see routes with good asphalt.

**Technical Approach:**

| Component              | Technology                                | Notes                                                            |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Vibration capture      | Accelerometer + Gyroscope (50Hz sampling) | Background service, low battery impact                           |
| Surface classification | ML model (TensorFlow Lite)                | Trained on labeled road segments: smooth/fair/rough/gravel/dirt  |
| Data aggregation       | Server-side pipeline                      | Multiple rider passes → confidence score per 100m segment        |
| Map overlay            | Vector tiles with quality heatmap         | Color-coded: green/yellow/orange/red                             |
| Hazard reports         | Real-time event system                    | Time-decay: hazards auto-expire after 24–72h unless re-confirmed |

### 3.2 EPIC 2: Smart Multi-Day Trip Planner

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

The trip planner replaces the manual process of checking roads via Street View and aerial photos. Riders define a region and parameters, and the app generates optimized multi-day routes that maximize fun-factor roads while respecting daily distance limits and accommodation needs.

**User Stories:**

- ✅ **US-6:** As a group leader, I want to draw a region on the map and see a heatmap of the best roads so that I can plan our trip around fun zones instead of A→B navigation.
- ✅ **US-7:** As a rider, I want to set trip parameters (days, daily km, road type preference) and get an auto-generated multi-day route so that planning takes minutes instead of hours.
- ✅ **US-8:** As a group member, I want to join a shared trip, suggest road segments, and vote on alternatives so that trip planning is collaborative.
- ✅ **US-9:** As a rider, I want to see Road Preview Cards for every segment (surface quality, curviness, elevation, photos, hazards) so that I don't need to check Street View.
- ✅ **US-10:** As a rider, I want the app to suggest accommodations and fuel stops near the best riding zones so that logistics fit around the riding, not the other way around.
- ✅ **US-11:** As a rider, I want to see seasonal/pass availability data so I don't plan a trip around a closed mountain pass.

**Fun Zone Discovery Algorithm:**

The system analyzes road geometry (curviness from OSM), elevation data, surface quality scores, and scenic ratings to cluster high-value road segments into "Fun Zones." Each zone gets a composite score. The trip planner then chains zones into daily routes, optimizing for: maximum fun-factor per day, reasonable daily distances, logical overnight stops, and fuel availability.

### 3.3 EPIC 3: Real-Time Safety & Alerts

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

**User Stories:**

- ✅ **US-12:** As a rider, I want crash detection that automatically alerts my emergency contacts if I'm in an accident so that help arrives even if I'm unconscious.
- ✅ **US-13:** As a rider, I want real-time weather alerts along my route so that I can reroute to avoid storms.
- ✅ **US-14:** As a rider, I want Waze-style community hazard alerts (oil, gravel, roadworks, animals, police) so that I'm warned about dangers ahead.
- ✅ **US-15:** As a commuter, I want the app to learn my usual route and proactively warn me about new hazards on my daily commute.

### 3.4 EPIC 4: Navigation & Ride Tracking

**Priority: P1 — HIGH** | **Sprint target:** MVP Phase 1

**User Stories:**

- ✅ **US-16:** As a rider, I want turn-by-turn voice navigation with motorcycle-specific instructions so that I don't miss turns.
- 🚧 **US-17:** As a rider, I want full CarPlay and Android Auto support from day one so that I can use my bike's display. _(JS bridge + iOS entitlements + AA Gradle dep + ride-status board / hazard alerts / quick-launch Commute landed in #498. Awaiting Apple CarPlay entitlement approval and a hardware-on-bike test pass before status flips to ✅ — see `docs/process/carplay-android-auto.md`.)_
- ✅ **US-18:** As a rider, I want offline maps and navigation so that I can ride in areas without cell coverage.
- ✅ **US-19:** As a rider, I want automatic ride tracking with stats (distance, duration, elevation, lean angles, top speed) so that I can review my rides.
- ✅ **US-20:** As a rider, I want GPX import/export so that I can use routes from other platforms.

### 3.5 EPIC 5: Commuter Mode

**Priority: P1 — HIGH** | **Sprint target:** MVP Phase 2

**User Stories:**

- ✅ **US-21:** As a commuter, I want a one-tap "Commute" button that navigates my daily route with real-time hazard and traffic info.
- ✅ **US-22:** As a commuter, I want the app to suggest alternative routes when my usual commute has issues (roadworks, accidents, weather).
- ✅ **US-23:** As a commuter, I want to see a weekly summary of my commute rides (time, distance, fuel estimate).

### 3.6 EPIC 6: Community & Social

**Priority: P2 — MEDIUM** | **Sprint target:** MVP Phase 2

**User Stories:**

- ✅ **US-24:** As a rider, I want to share my rides and routes with the community so that others can discover great roads.
- ✅ **US-25:** As a rider, I want to rate and review road segments with photos so that the community database improves over time.
- ✅ **US-26:** As a group rider, I want real-time location sharing with my riding group so that we stay connected on the road.
- ✅ **US-27:** As a rider, I want to follow other riders and see their recommended routes in my area.

### 3.7 EPIC 7: Gamification & Engagement

**Priority: P3 — NICE-TO-HAVE** | **Sprint target:** Phase 3

**User Stories:**

- ✅ **US-28:** As a rider, I want to earn badges for riding milestones (km ridden, roads discovered, hazards reported) so that I stay engaged.
- ✅ **US-29:** As a rider, I want seasonal challenges (e.g., "Ride 10 new roads this month") to motivate exploration.
- ✅ **US-30:** As a rider, I want a personal road map showing which roads I've ridden vs. haven't, motivating me to explore new areas.

---

## 4. Product Roadmap

| Phase                   | Timeline   | Epics                                                       | Key Deliverables                                                                                                                                                                   |
| ----------------------- | ---------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1: MVP**        | Q3–Q4 2026 | Road Surface Intelligence, Trip Planner, Safety, Navigation | Core mobile app with surface quality sensing, basic trip planning, crash detection, turn-by-turn nav, CarPlay/AA. **Web:** Trip planner, road quality explorer, account management |
| **Phase 2: Growth**     | Q1–Q2 2027 | Commuter Mode, Community & Social                           | Daily commute features, ride sharing, group features, road reviews. **Web:** Community hub, ride history dashboard, analytics                                                      |
| **Phase 3: Engagement** | Q3 2027+   | Gamification, Advanced Analytics                            | Badges, challenges, personal road maps, advanced ride stats, API for 3rd parties. **Web:** Gamification dashboard, API docs                                                        |

### 4.1 MVP Success Criteria

| Metric                          | Target (6 months post-launch)         | Measurement         |
| ------------------------------- | ------------------------------------- | ------------------- |
| Downloads                       | 50,000+                               | App store analytics |
| Monthly Active Riders           | 15,000+                               | In-app analytics    |
| Road segments with quality data | 500,000+ segments                     | Backend database    |
| Avg. session duration           | > 8 min (planning), > 30 min (riding) | Analytics           |
| Hazard reports per day          | 1,000+                                | Community activity  |
| App Store rating                | 4.5+                                  | Store reviews       |
| Premium conversion rate         | > 8%                                  | Revenue analytics   |

---

## 5. Technical Architecture Overview

### 5.1 Tech Stack

| Layer       | Technology                                                           | Rationale                                                                             |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mobile App  | React Native (bare)                                                  | Cross-platform, CarPlay/AA support, background sensor access                          |
| **Web App** | **Next.js (TypeScript)**                                             | **Shared TS ecosystem with mobile + backend, SSR for landing/SEO, SPA for app views** |
| Maps        | MapLibre GL + custom vector tiles                                    | Open-source, customizable styling, offline support, no Google licensing costs         |
| Backend API | Node.js (NestJS) or Python (FastAPI)                                 | High-performance, well-suited for real-time data processing                           |
| Database    | PostgreSQL + PostGIS                                                 | Geospatial queries, road segment indexing, proven at scale                            |
| Real-time   | WebSockets (Socket.io) + Redis Pub/Sub                               | Live hazard alerts, group ride tracking                                               |
| ML Pipeline | TensorFlow Lite (on-device)                                          | On-device road classification, server-side aggregation via NestJS ingest pipeline     |
| Cloud       | Self-hosted PaaS (backend container) + Cloudflare (R2, Workers, DNS) | Self-hosted PaaS, no egress fees on R2, global CDN for tiles + companion              |
| Analytics   | PostHog (self-hosted) or Mixpanel                                    | Privacy-first analytics, funnel tracking                                              |

### 5.2 Road Quality Data Pipeline

The road quality pipeline is the core innovation and consists of four stages:

1. **Collection:** Smartphone accelerometer + gyroscope data sampled at 50Hz during rides. GPS coordinates linked to each measurement window. Battery-optimized background service.

2. **Classification:** On-device TF Lite model classifies each 100m segment into quality tiers (Excellent / Good / Fair / Poor / Very Poor) based on vibration patterns. Model also detects surface type (asphalt / concrete / cobblestone / gravel / dirt).

3. **Aggregation:** Server combines data from multiple riders over time. Confidence score increases with more passes. Outliers (e.g., one rough reading on a smooth road) are filtered. Recency-weighted: newer data has higher weight.

4. **Visualization:** Road quality rendered as color-coded map overlay (green→red). Available as vector tile layer for offline use. Quality scores exposed via API for routing engine integration.

---

## 6. Monetization Strategy

| Tier        | Price       | Features                                                                                                                                            |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free**    | €0          | Basic navigation, ride tracking, road quality overlay (limited zoom), hazard alerts, community access, 1 active trip plan                           |
| **Pro**     | €29.99/year | Unlimited trip planning, full road quality zoom, offline maps, commuter mode, advanced ride stats, GPX export, collaborative trips (up to 5 riders) |
| **Premium** | €49.99/year | Everything in Pro + group rides (unlimited), priority hazard alerts, API access, route export to Garmin, advanced analytics dashboard               |

Prices are EUR-denominated; see ADR-0003 and `SUBSCRIPTION_PRICING` in `@tarmoto/shared`. The pricing strategy is deliberately positioned below Calimoto (~~€55/year) and above Kurviger (~~€28/year), offering significantly more value. The free tier must be compelling enough to drive adoption (and road quality data collection), while premium features create clear upgrade motivation.

### 6.1 Revenue Projections (Year 1)

| Quarter          | Downloads (cumulative) | MAU    | Premium Conv. | MRR Estimate |
| ---------------- | ---------------------- | ------ | ------------- | ------------ |
| Q1 2027 (Launch) | 10,000                 | 3,000  | 5%            | €1,250       |
| Q2 2027          | 30,000                 | 10,000 | 7%            | €4,375       |
| Q3 2027 (Season) | 80,000                 | 30,000 | 9%            | €16,875      |
| Q4 2027          | 120,000                | 25,000 | 10%           | €15,625      |

---

## 7. Risks & Mitigations

| Risk                                    | Impact | Likelihood | Mitigation                                                                                                                                                                |
| --------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cold start: no road data at launch**  | High   | High       | Pre-seed data by partnering with cycling/driving communities. Organize beta rider campaigns in key regions. Import OpenStreetMap surface tags where available.            |
| Battery drain from sensors              | Medium | Medium     | Optimize sampling rate (reduce when on straight roads). Batch upload data on Wi-Fi. Provide battery usage dashboard to users.                                             |
| Accelerometer accuracy varies by phone  | Medium | High       | Calibration routine on first use. ML model trained on diverse phone models. Aggregate multiple readings to smooth out device variance.                                    |
| Competitor copies the feature           | Medium | Medium     | First-mover advantage + network effect. The more riders, the better the data — hard to replicate. Patent core algorithms where possible.                                  |
| Privacy concerns with location tracking | High   | Low        | Data anonymized before upload. No personal identifiers attached to road quality data. Clear opt-in consent. GDPR/privacy-by-design from day one.                          |
| Map licensing costs at scale            | Medium | Medium     | Use open-source MapLibre + OpenStreetMap. Custom tile server. No dependency on Google Maps pricing.                                                                       |
| Web/mobile feature parity drift         | Medium | Medium     | Shared NestJS API means one backend. Establish clear "web-first" vs "mobile-first" feature ownership per epic. Shared TypeScript types via monorepo or published package. |
| SEO & discoverability for web app       | Medium | Low        | Next.js SSR for public pages (route collections, road quality explorer). Structured data for routes. Content marketing via "Best Roads in [Region]" pages.                |

---

## 8. Next Steps

| #   | Action Item                                                                                  | Owner            | Due Date      | Status         |
| --- | -------------------------------------------------------------------------------------------- | ---------------- | ------------- | -------------- |
| 1   | Validate road quality ML model with test rides (3 phone models, 5 road types)                | Tech Lead        | May 2026      | Not Started    |
| 2   | Create interactive wireframes for core flows (trip planner, ride mode, road quality overlay) | Design Lead      | May 2026      | ✅ Done        |
| 3   | Set up backend infrastructure (PostGIS, tile server, API scaffold)                           | Backend Dev      | June 2026     | ✅ Done        |
| 4   | Beta rider recruitment (target: 200 riders in CZ/SK region)                                  | Product          | June 2026     | Not Started    |
| 5   | Legal review: privacy policy, GDPR compliance, location data handling                        | Legal            | July 2026     | Not Started    |
| 6   | **Web: scaffold Next.js project, auth integration, MapLibre GL setup**                       | **Frontend Dev** | **June 2026** | ✅ Done        |
| 7   | **Web: trip planner MVP (map drawing, route generation, road preview cards)**                | **Frontend Dev** | **Aug 2026**  | 🚧 In Progress |
| 8   | **Web: road quality explorer + ride history dashboard**                                      | **Frontend Dev** | **Sep 2026**  | 🚧 In Progress |
| 9   | **Web: community hub + account management**                                                  | **Frontend Dev** | **Oct 2026**  | 🚧 In Progress |
| 10  | MVP feature-complete build (mobile + web)                                                    | Engineering      | Oct 2026      | 🚧 In Progress |
| 11  | Closed beta launch (CZ/SK/AT)                                                                | Product          | Nov 2026      | Not Started    |
| 12  | Public launch on App Store, Google Play & web                                                | All              | Q1 2027       | Not Started    |

### 8.1 Infrastructure (Completed May 2026)

| Item                                                                | Status |
| ------------------------------------------------------------------- | ------ |
| Backend host (self-hosted PaaS) provisioned                         | ✅     |
| PostGIS 17 + Redis 8 (prod + staging)                               | ✅     |
| Cloudflare R2 object storage (avatars, exports, tiles)              | ✅     |
| CI/CD: GitHub Actions (backend-deploy, companion-deploy, mobile CI) | ✅     |
| Staging environment (`api-staging.tarmoto.app`)                     | ✅     |
| Auto-migration on deploy (TypeORM)                                  | ✅     |
| Smoke tests + auto-rollback on deploy failure                       | ✅     |

### 8.2 What's Still Needed Before Launch

| Item                                                            | Priority |
| --------------------------------------------------------------- | -------- |
| Stripe subscription keys (live)                                 | P0       |
| Push notification credentials (FCM + APN)                       | P1       |
| Production email provider (Resend or SMTP — currently log-only) | P1       |
| App Store / Google Play developer accounts                      | P0       |
| OpenWeatherMap API key                                          | P2       |
| Legal review (privacy policy, GDPR)                             | P0       |
| Beta rider recruitment                                          | P1       |
| Mobile release build pipeline end-to-end                        | P1       |

---

## 9. Web Interface — Tarmoto Web Companion

### 9.1 Strategy & Platform Role

The Tarmoto web companion (`app.tarmoto.app`) is a full-featured browser application that complements the mobile app. The core philosophy is **plan on desktop, ride on mobile** — each platform plays to its strengths.

The web interface is not a secondary experience. For the trip planning workflow, it is the _primary_ experience. Drawing regions on a full-screen map, comparing road preview cards side-by-side, and collaborating with a riding group are all fundamentally desktop-first interactions.

**Platform responsibility matrix:**

| Capability                     | Web           | Mobile       | Notes                                         |
| ------------------------------ | ------------- | ------------ | --------------------------------------------- |
| Trip planning & route building | **Primary**   | Secondary    | Full-screen map, drag-and-drop, collaboration |
| Road quality explorer          | **Primary**   | Secondary    | Large map, detailed segment panels            |
| Ride recording & sensors       | ✗             | **Primary**  | Accelerometer, GPS, background services       |
| Turn-by-turn navigation        | ✗             | **Primary**  | CarPlay/AA, voice, offline                    |
| Ride history & analytics       | **Primary**   | Summary view | Charts, comparisons, data export              |
| Community browsing             | **Primary**   | Feed view    | Route discovery, reviews, profiles            |
| Hazard reporting               | Review/manage | **Primary**  | One-tap reporting during rides                |
| Account & settings             | **Primary**   | Basic        | Subscription, privacy, data export            |
| Real-time safety alerts        | ✗             | **Primary**  | Crash detection, weather, hazards             |
| Commuter mode                  | ✗             | **Primary**  | Daily route, quick launch                     |

**Shared backend:** Both platforms consume the same NestJS API. No BFF layer — the API is designed with platform-agnostic endpoints. Authentication is shared via JWT tokens (same login works on web and mobile). Real-time features (hazard alerts, group ride tracking) use the same WebSocket/Redis Pub/Sub infrastructure.

### 9.2 Web Epics & User Stories

The web interface is organized into 5 epics. User story numbering continues from the mobile PRD (US-31+). Each web epic maps to one or more mobile epics, ensuring feature alignment without duplication.

#### 9.2.1 WEB-EPIC 1: Trip Planner (Desktop-First)

**Priority: P0 — CRITICAL** | **Sprint target:** Web MVP | **Maps to:** Mobile Epic 2

This is the flagship web feature. The full-screen trip planner provides a dramatically better planning experience than any mobile screen can offer, and positions Tarmoto as the planning tool of choice — even before riders install the mobile app.

**User Stories:**

- ✅ **US-31:** As a rider, I want to open a full-screen map and draw a region of interest so that I can discover Fun Zones (high-value road clusters) within that area.
- ✅ **US-32:** As a rider, I want to drag-and-drop waypoints on the map and see the route auto-adjust through the best road segments so that route building feels intuitive and visual.
- ✅ **US-33:** As a rider, I want a sidebar showing Road Preview Cards for each segment of my planned route (surface quality score, curviness rating, elevation profile, street-level photos, active hazards) so that I can evaluate every section without leaving the planner.
- ✅ **US-34:** As a rider, I want to set trip parameters (number of days, daily km target, road type preference, avoidance criteria) and click "Generate" to receive an AI-optimized multi-day itinerary so that planning takes minutes, not hours.
- ✅ **US-35:** As a group leader, I want to share a trip link with my riding group, where each member can suggest alternative road segments, add waypoints, and vote on route options so that planning is collaborative.
- ✅ **US-36:** As a rider, I want the planner to suggest accommodations, fuel stops, and points of interest near Fun Zones and along the route so that logistics fit around the riding.
- ✅ **US-37:** As a rider, I want to save multiple trip drafts, duplicate and modify existing trips, and organize trips into folders (e.g., "Summer 2026 Alps", "Weekend Beskydy") so that I can manage my plans over time.
- ✅ **US-38:** As a rider, I want to import GPX/KML files into the planner and see them overlaid with road quality data so that I can evaluate routes from other sources.
- ✅ **US-39:** As a rider, I want to export my planned route as GPX for Garmin devices, as a shareable link, or push it directly to the Tarmoto mobile app so that the transition from planning to riding is seamless.
- ✅ **US-40:** As a rider, I want to see seasonal road closures, mountain pass status, and construction zones on the planner map so that I don't plan trips around unavailable roads.

**Multi-Day Planning (Phase 2):**

Phase 2 extends manual route planning to support multi-day trips. Riders build itineraries day-by-day on a tabbed interface, with live per-day routing and an intelligent overnight link that chains consecutive days:

- **Day tabs:** Switchable tabs for each day (1–14 days max), with summary distance/duration. Controls to add or remove days.
- **Chained overnight link:** Day N+1's start location automatically mirrors day N's end location and re-routes live when the end is edited. Riders can override this link by placing a new start, or relink using an affordance.
- **All days on map:** All days render color-coded by day number, with the selected day emphasized and interactive. A focus toggle isolates the selected day for clarity.
- **Per-day live routing:** Editing waypoints on the selected day triggers a live route update via Valhalla for that day only. Cascading overnight edits re-route both days.
- **Completeness gating:** Save is enabled only when ≥1 day is complete (has valid start→end and routable waypoints) and zero days are incomplete (partially placed waypoints). Empty days are auto-dropped on save; remaining days are renumbered (1..N).
- **Name-only persistence:** Editing only waypoint labels — e.g. a reverse-geocoded pin name or an edited `Start`/`Finish`/`Via` label — arms Save without a route change. On a loaded or imported trip this persists through a name-only path that updates the stored names in place and leaves geometry, order, and day structure untouched (no re-route), so an imported GPX or manually adjusted route keeps its exact shape. Freshly planned trips already carry a dirty route and persist names as part of the normal save.
- **Link state persistence:** A `start_linked` flag per day encodes whether that day's start is chained to the previous day's end. On reload, the link state and all route geometry restore.

Out of scope for Phase 2: automated multi-day route generation (Calimoto-style round-trip optimization) and motorcycle-specific routing profiles (curvy roads). These remain planned for a later phase.

**Key UX elements:**

| Element           | Description                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Map canvas        | Full-screen MapLibre GL JS with road quality heatmap, Fun Zone clusters, and route overlay (all days color-coded) |
| Day tabs          | Tab bar for each day with distance/duration summary, "+" to add, remove control per day                           |
| Segment sidebar   | Scrollable list of Road Preview Cards, each expandable for full detail                                            |
| Parameter panel   | Collapsible panel for trip settings: days, km/day, road preferences, avoidance                                    |
| Collaboration bar | Shows connected group members, their cursor positions on the map, and pending suggestions                         |
| Focus toggle      | Toggle to show all days or isolate the selected day on the map                                                    |
| Overnight link UI | "Link to previous day" affordance when start is unlinked; clicking re-links and re-seeds start from predecessor   |

#### 9.2.2 WEB-EPIC 2: Road Quality Explorer

**Priority: P0 — CRITICAL** | **Sprint target:** Web MVP | **Maps to:** Mobile Epic 1

The road quality explorer is the public-facing showcase of Tarmoto's crowdsourced data. It makes the proprietary database tangible, serves as a marketing tool ("look what our community has mapped"), and drives organic traffic via SEO.

**User Stories:**

- ✅ **US-41:** As a visitor (no account required), I want to browse a full-screen road quality heatmap so that I can see road conditions in any region.
- ✅ **US-42:** As a rider, I want to click any road segment and see a detail panel (quality score, surface type, confidence level, number of rider passes, last updated, trend over time, photos) so that I get a complete picture of road conditions.
- ✅ **US-43:** As a rider, I want to filter the map by quality tier (Excellent→Very Poor), surface type (asphalt/concrete/cobblestone/gravel/dirt), and curviness rating so that I find exactly the kind of roads I'm looking for.
- ✅ **US-44:** As a rider, I want to see active hazard markers on the map with details (type, reporter, time, confirmations) so that I can check current dangers before heading out.
- ✅ **US-45:** As a rider, I want to view a road quality trend graph for any segment (how quality has changed over months/years) so that I can see if a road is deteriorating or recently repaired.
- ✅ **US-46:** As a visitor, I want curated "Best Roads" pages (e.g., "Best Roads in Beskydy", "Top 10 Alpine Passes") auto-generated from community data so that I discover great rides through search engines.

**SEO strategy:** Public road quality pages and "Best Roads in [Region]" pages are server-side rendered (Next.js SSR) with structured data markup. These pages drive organic traffic and convert visitors → app installs. The explorer doubles as Tarmoto's content marketing engine.

#### 9.2.3 WEB-EPIC 3: Ride History & Analytics Dashboard

**Priority: P1 — HIGH** | **Sprint target:** Web Phase 2 | **Maps to:** Mobile Epics 4 & 7

The web dashboard gives riders a rich view of their riding data — something a phone screen can't do justice. This is the Strava-equivalent experience for motorcyclists.

**User Stories:**

- ✅ **US-47:** As a rider, I want to see all my past rides on a map with filterable list view (by date, distance, duration, road quality encountered) so that I can browse my riding history.
- ✅ **US-48:** As a rider, I want to click any ride and see a detailed view: route on map, elevation profile, speed graph, road quality breakdown per segment, and ride stats (distance, time, avg speed, elevation gain) so that I can relive and analyze my rides.
- ✅ **US-49:** As a rider, I want a stats dashboard showing my all-time totals, monthly/yearly trends (km ridden, rides taken, roads discovered), and comparative charts so that I can track my riding over time.
- ✅ **US-50:** As a rider, I want a personal road map — a map overlay showing every road I've ridden (highlighted) vs. roads I haven't (dimmed) — so that I'm motivated to explore new areas.
- ✅ **US-51:** As a rider, I want to compare two rides side-by-side (same route at different times, or two different routes) so that I can see how conditions or my riding changed.
- ✅ **US-52:** As a rider, I want to export my ride data as CSV, GPX, or via the API so that I can use it in other tools.

#### 9.2.4 WEB-EPIC 4: Community Hub

**Priority: P2 — MEDIUM** | **Sprint target:** Web Phase 2 | **Maps to:** Mobile Epics 6 & 7

The community hub turns Tarmoto from a utility into a destination. Riders browse routes, discover roads, follow other riders, and build reputation in the community.

**User Stories:**

- ✅ **US-53:** As a rider, I want to browse a feed of shared routes and rides from the community, filterable by region, distance, curviness, road quality, and popularity so that I discover new roads.
- ✅ **US-54:** As a rider, I want to view other riders' public profiles (rides shared, roads discovered, badges earned, route collections) so that I can follow riders with good taste in roads.
- ✅ **US-55:** As a rider, I want to rate and write reviews for road segments with photo uploads so that I help the community database grow beyond sensor data.
- ✅ **US-56:** As a rider, I want to create and share route collections (e.g., "My Favorite Beskydy Loops", "Best Gravel Roads in Moravia") so that I can curate recommendations.
- ✅ **US-57:** As a rider, I want to see a gamification dashboard with my badges, active challenges, leaderboard position, and progress toward next milestones so that I stay engaged.
- ❌ **US-58 (retired 2026-07):** Embeddable route / road-quality widgets were built and later removed — no measurable usage, and most platforms strip iframes; the public share pages with OpenGraph cards cover external sharing. Legacy `/embed/*` URLs permanently redirect to the full share/Best-Roads pages.

#### 9.2.5 WEB-EPIC 5: Account & Settings

**Priority: P1 — HIGH** | **Sprint target:** Web MVP | **Maps to:** Cross-cutting

Account management is a baseline requirement. The web interface is the primary place for subscription management, privacy controls, and data administration — tasks that are awkward on mobile.

**User Stories:**

- ✅ **US-59:** As a user, I want to create an account (email or social login), manage my profile (display name, avatar, bike info, home region), and link my mobile app so that my data syncs across platforms.
- ✅ **US-60:** As a user, I want to manage my subscription tier (Free/Premium/Pro), view billing history, and update payment methods so that I control my account from the web.
- ✅ **US-61:** As a user, I want to configure my privacy settings (profile visibility, ride sharing defaults, road data contribution opt-in/out, location data retention) so that I control what I share.
- ✅ **US-62:** As a user, I want to export all my data (rides, routes, profile) or delete my account and all associated data so that Tarmoto complies with GDPR.
- ✅ **US-63:** As a user, I want to manage notification preferences (email digests, hazard alerts for saved routes, community activity) so that I only receive relevant communications.
- ✅ **US-64:** As a user, I want to manage my bikes (make, model, year) and set the active bike so that ride stats and recommendations are bike-aware.

### 9.3 Web Technical Architecture

The web app shares the NestJS backend with mobile. No BFF — the same API endpoints serve both clients. Web-specific concerns are handled in the frontend layer.

| Layer              | Technology                                                        | Notes                                                                  |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Framework          | Next.js 14+ (App Router, TypeScript)                              | SSR for public/SEO pages, SPA for authenticated app views              |
| Styling            | Tailwind CSS                                                      | Consistent with mobile design tokens, rapid development                |
| State management   | Zustand                                                           | Same library as mobile — potential for shared store patterns           |
| Map engine         | MapLibre GL JS                                                    | Same tile format as mobile. Road quality heatmap via vector tile layer |
| Real-time          | Socket.io client                                                  | Collaborative planning cursors, live hazard updates                    |
| Charts & analytics | Recharts or D3.js                                                 | Ride stats, road quality trends, dashboard charts                      |
| Auth               | NextAuth.js → shared JWT with NestJS                              | SSO: same account works on web and mobile                              |
| API client         | Generated from NestJS OpenAPI spec (`openapi-typescript-codegen`) | Type-safe, always in sync with backend                                 |
| Hosting            | Vercel or Cloudflare Pages                                        | Edge-deployed, fast globally, pairs with Cloudflare domain             |
| Testing            | Playwright (E2E), Vitest (unit)                                   | Critical flows: trip creation, auth, payment                           |

**Shared code strategy:** TypeScript types (API request/response shapes, road quality enums, segment models) are published as an internal npm package or monorepo shared directory, consumed by mobile (React Native), web (Next.js), and backend (NestJS). This eliminates type drift between platforms.

**Map tile pipeline (shared):** Both web and mobile consume the same vector tiles served from the tile server. The road quality heatmap layer is the same data, same styling rules, rendered by MapLibre GL JS (web) and MapLibre GL Native (mobile).

### 9.4 Web Roadmap

The web roadmap runs in parallel with mobile, with the trip planner delivered first to validate the desktop-first planning hypothesis.

| Phase           | Timeline   | Epics                                     | Key Deliverables                                                                                                                                |
| --------------- | ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web Alpha**   | Q3 2026    | WEB-EPIC 1, WEB-EPIC 5 (partial)          | Next.js scaffold, auth, MapLibre integration, basic trip planner with Fun Zone map and route building. Account creation and profile management. |
| **Web MVP**     | Q4 2026    | WEB-EPIC 1 (full), WEB-EPIC 2, WEB-EPIC 5 | Full trip planner with collaboration, Road Preview Cards, GPX import/export. Road quality explorer with public pages. Full account management.  |
| **Web Phase 2** | Q1–Q2 2027 | WEB-EPIC 3, WEB-EPIC 4                    | Ride history dashboard, analytics, personal road map. Community hub, route collections, profiles, gamification dashboard.                       |
| **Web Phase 3** | Q3 2027+   | Enhancements                              | Embeddable widgets, API documentation portal, advanced analytics, public API explorer.                                                          |

### 9.5 Web MVP Success Criteria

| Metric                               | Target (3 months post-launch)    | Measurement                   |
| ------------------------------------ | -------------------------------- | ----------------------------- |
| Monthly active web users             | 5,000+                           | Analytics                     |
| Trips created via web                | 60%+ of all trip plans           | Backend metrics               |
| Web → mobile install conversion      | 25%+ of web users install mobile | Attribution tracking          |
| Avg. planning session duration       | > 12 min                         | Analytics                     |
| Road quality explorer page views     | 50,000+/month                    | Analytics (incl. SEO traffic) |
| "Best Roads" pages indexed by Google | 100+ region pages                | Search Console                |

---

_End of Document_

**Tarmoto — Know the road before you ride it.**
