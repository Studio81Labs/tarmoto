# TARMOTO — Product Requirements Document

> **Know the road before you ride it.**

Version 1.0 | April 2026 | CONFIDENTIAL

| Field | Value |
|-------|-------|
| Document Status | Draft |
| Author | Product Team |
| Last Updated | April 10, 2026 |
| Target Platform | iOS & Android (React Native) |
| Target Launch | Q1 2027 (MVP) |

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

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Daily Commuter | Rides to work 5 days/week, wants the safest and fastest route | Real-time hazard alerts, road quality on commute routes |
| Weekend Explorer | Rides for fun on weekends, looking for great roads nearby | Fun-factor road discovery, surface quality assurance |
| Touring Group | Plans multi-day trips with friends, needs collaborative tools | Multi-day trip builder, road preview, group coordination |
| Adventure Rider | Off-road and mixed-terrain, needs surface type information | Surface type classification (asphalt/gravel/dirt) |

### 1.3 Unique Value Proposition

> ***"Know the road before you ride it."*** Tarmoto is the only motorcycle app that tells you how good the actual asphalt is, not just how curvy the road looks on a map.

---

## 2. Competitive Analysis

The motorcycle app market has several established players, each with distinct strengths but a common blind spot: none address road surface quality or provide real-time rider safety intelligence.

| Feature | Calimoto | Kurviger | Scenic | REVER | Tarmoto |
|---------|----------|----------|--------|-------|---------|
| Curvy road routing | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Road surface quality** | ✗ | ✗ | ✗ | ✗ | **✓** |
| **Real-time hazard alerts** | ✗ | ✗ | ✗ | ✗ | **✓** |
| **Multi-day trip AI builder** | Limited | Web only | ✗ | ✗ | **✓** |
| **Road preview cards** | ✗ | ✗ | ✗ | ✗ | **✓** |
| **Collaborative planning** | ✗ | ✗ | ✗ | Basic | **✓** |
| Crash detection | ✗ | ✗ | ✗ | ✗ | **✓** |
| CarPlay + Android Auto | CarPlay only | AA only | ✗ | ✗ | **Both** |
| Commuter mode | ✗ | ✗ | ✗ | ✗ | **✓** |
| Offline maps | ✓ (paid) | ✓ (paid) | ✓ | ✗ | ✓ |
| Social / community | Basic | Forum | ✗ | ✓ | ✓ |
| Pricing | $60/yr | $30/yr | $25 lifetime | Free+ | Freemium |

---

## 3. Epics & Feature Breakdown

The product is organized into 7 epics, each representing a major capability area. Epics are prioritized by business impact and technical dependency.

### 3.1 EPIC 1: Road Surface Intelligence (Killer Feature)

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

Every rider using Tarmoto passively collects road surface quality data via smartphone accelerometers. The app measures vibration patterns and classifies road segments into quality tiers. Over time, this builds a proprietary database of road conditions that no competitor can replicate.

**User Stories:**

- **US-1:** As a rider, I want to see a road quality overlay on the map so that I can avoid roads with poor asphalt before I ride them.
- **US-2:** As a rider, I want my phone to automatically record road surface data while I ride so that I contribute to the community without any extra effort.
- **US-3:** As a rider, I want to see a Road Quality Score (1–5) for each road segment so that I can quickly assess if a road is worth riding.
- **US-4:** As a rider, I want to report specific hazards (pothole, gravel, oil spill) with a single tap so that other riders are warned immediately.
- **US-5:** As a route planner, I want to filter routes by minimum road quality so that I only see routes with good asphalt.

**Technical Approach:**

| Component | Technology | Notes |
|-----------|-----------|-------|
| Vibration capture | Accelerometer + Gyroscope (50Hz sampling) | Background service, low battery impact |
| Surface classification | ML model (TensorFlow Lite) | Trained on labeled road segments: smooth/fair/rough/gravel/dirt |
| Data aggregation | Server-side pipeline | Multiple rider passes → confidence score per 100m segment |
| Map overlay | Vector tiles with quality heatmap | Color-coded: green/yellow/orange/red |
| Hazard reports | Real-time event system | Time-decay: hazards auto-expire after 24–72h unless re-confirmed |

### 3.2 EPIC 2: Smart Multi-Day Trip Planner

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

The trip planner replaces the manual process of checking roads via Street View and aerial photos. Riders define a region and parameters, and the app generates optimized multi-day routes that maximize fun-factor roads while respecting daily distance limits and accommodation needs.

**User Stories:**

- **US-6:** As a group leader, I want to draw a region on the map and see a heatmap of the best roads so that I can plan our trip around fun zones instead of A→B navigation.
- **US-7:** As a rider, I want to set trip parameters (days, daily km, road type preference) and get an auto-generated multi-day route so that planning takes minutes instead of hours.
- **US-8:** As a group member, I want to join a shared trip, suggest road segments, and vote on alternatives so that trip planning is collaborative.
- **US-9:** As a rider, I want to see Road Preview Cards for every segment (surface quality, curviness, elevation, photos, hazards) so that I don't need to check Street View.
- **US-10:** As a rider, I want the app to suggest accommodations and fuel stops near the best riding zones so that logistics fit around the riding, not the other way around.
- **US-11:** As a rider, I want to see seasonal/pass availability data so I don't plan a trip around a closed mountain pass.

**Fun Zone Discovery Algorithm:**

The system analyzes road geometry (curviness from OSM), elevation data, surface quality scores, and scenic ratings to cluster high-value road segments into "Fun Zones." Each zone gets a composite score. The trip planner then chains zones into daily routes, optimizing for: maximum fun-factor per day, reasonable daily distances, logical overnight stops, and fuel availability.

### 3.3 EPIC 3: Real-Time Safety & Alerts

**Priority: P0 — CRITICAL** | **Sprint target:** MVP Phase 1

**User Stories:**

- **US-12:** As a rider, I want crash detection that automatically alerts my emergency contacts if I'm in an accident so that help arrives even if I'm unconscious.
- **US-13:** As a rider, I want real-time weather alerts along my route so that I can reroute to avoid storms.
- **US-14:** As a rider, I want Waze-style community hazard alerts (oil, gravel, roadworks, animals, police) so that I'm warned about dangers ahead.
- **US-15:** As a commuter, I want the app to learn my usual route and proactively warn me about new hazards on my daily commute.

### 3.4 EPIC 4: Navigation & Ride Tracking

**Priority: P1 — HIGH** | **Sprint target:** MVP Phase 1

**User Stories:**

- **US-16:** As a rider, I want turn-by-turn voice navigation with motorcycle-specific instructions so that I don't miss turns.
- **US-17:** As a rider, I want full CarPlay and Android Auto support from day one so that I can use my bike's display.
- **US-18:** As a rider, I want offline maps and navigation so that I can ride in areas without cell coverage.
- **US-19:** As a rider, I want automatic ride tracking with stats (distance, duration, elevation, lean angles, top speed) so that I can review my rides.
- **US-20:** As a rider, I want GPX import/export so that I can use routes from other platforms.

### 3.5 EPIC 5: Commuter Mode

**Priority: P1 — HIGH** | **Sprint target:** MVP Phase 2

**User Stories:**

- **US-21:** As a commuter, I want a one-tap "Commute" button that navigates my daily route with real-time hazard and traffic info.
- **US-22:** As a commuter, I want the app to suggest alternative routes when my usual commute has issues (roadworks, accidents, weather).
- **US-23:** As a commuter, I want to see a weekly summary of my commute rides (time, distance, fuel estimate).

### 3.6 EPIC 6: Community & Social

**Priority: P2 — MEDIUM** | **Sprint target:** MVP Phase 2

**User Stories:**

- **US-24:** As a rider, I want to share my rides and routes with the community so that others can discover great roads.
- **US-25:** As a rider, I want to rate and review road segments with photos so that the community database improves over time.
- **US-26:** As a group rider, I want real-time location sharing with my riding group so that we stay connected on the road.
- **US-27:** As a rider, I want to follow other riders and see their recommended routes in my area.

### 3.7 EPIC 7: Gamification & Engagement

**Priority: P3 — NICE-TO-HAVE** | **Sprint target:** Phase 3

**User Stories:**

- **US-28:** As a rider, I want to earn badges for riding milestones (km ridden, roads discovered, hazards reported) so that I stay engaged.
- **US-29:** As a rider, I want seasonal challenges (e.g., "Ride 10 new roads this month") to motivate exploration.
- **US-30:** As a rider, I want a personal road map showing which roads I've ridden vs. haven't, motivating me to explore new areas.

---

## 4. Product Roadmap

| Phase | Timeline | Epics | Key Deliverables |
|-------|----------|-------|------------------|
| **Phase 1: MVP** | Q3–Q4 2026 | Road Surface Intelligence, Trip Planner, Safety, Navigation | Core app with surface quality sensing, basic trip planning, crash detection, turn-by-turn nav, CarPlay/AA |
| **Phase 2: Growth** | Q1–Q2 2027 | Commuter Mode, Community & Social | Daily commute features, ride sharing, group features, road reviews |
| **Phase 3: Engagement** | Q3 2027+ | Gamification, Advanced Analytics | Badges, challenges, personal road maps, advanced ride stats, API for 3rd parties |

### 4.1 MVP Success Criteria

| Metric | Target (6 months post-launch) | Measurement |
|--------|-------------------------------|-------------|
| Downloads | 50,000+ | App store analytics |
| Monthly Active Riders | 15,000+ | In-app analytics |
| Road segments with quality data | 500,000+ segments | Backend database |
| Avg. session duration | > 8 min (planning), > 30 min (riding) | Analytics |
| Hazard reports per day | 1,000+ | Community activity |
| App Store rating | 4.5+ | Store reviews |
| Premium conversion rate | > 8% | Revenue analytics |

---

## 5. Technical Architecture Overview

### 5.1 Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Mobile App | React Native + Expo | Cross-platform, large ecosystem, CarPlay/AA support via modules |
| Maps | MapLibre GL + custom vector tiles | Open-source, customizable styling, offline support, no Google licensing costs |
| Backend API | Node.js (NestJS) or Python (FastAPI) | High-performance, well-suited for real-time data processing |
| Database | PostgreSQL + PostGIS | Geospatial queries, road segment indexing, proven at scale |
| Real-time | WebSockets (Socket.io) + Redis Pub/Sub | Live hazard alerts, group ride tracking |
| ML Pipeline | TensorFlow Lite (on-device) + Python (server) | On-device road classification, server-side aggregation |
| Cloud | AWS (ECS, RDS, S3, CloudFront) | Scalable, cost-effective, CDN for map tiles |
| Analytics | PostHog (self-hosted) or Mixpanel | Privacy-first analytics, funnel tracking |

### 5.2 Road Quality Data Pipeline

The road quality pipeline is the core innovation and consists of four stages:

1. **Collection:** Smartphone accelerometer + gyroscope data sampled at 50Hz during rides. GPS coordinates linked to each measurement window. Battery-optimized background service.

2. **Classification:** On-device TF Lite model classifies each 100m segment into quality tiers (Excellent / Good / Fair / Poor / Very Poor) based on vibration patterns. Model also detects surface type (asphalt / concrete / cobblestone / gravel / dirt).

3. **Aggregation:** Server combines data from multiple riders over time. Confidence score increases with more passes. Outliers (e.g., one rough reading on a smooth road) are filtered. Recency-weighted: newer data has higher weight.

4. **Visualization:** Road quality rendered as color-coded map overlay (green→red). Available as vector tile layer for offline use. Quality scores exposed via API for routing engine integration.

---

## 6. Monetization Strategy

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | Basic navigation, ride tracking, road quality overlay (limited zoom), hazard alerts, community access, 1 active trip plan |
| **Premium** | $29.99/year | Unlimited trip planning, full road quality zoom, offline maps, commuter mode, advanced ride stats, GPX export, collaborative trips (up to 5 riders) |
| **Pro** | $49.99/year | Everything in Premium + group rides (unlimited), priority hazard alerts, API access, route export to Garmin, advanced analytics dashboard |

The pricing strategy is deliberately positioned below Calimoto ($60/year) and above Kurviger ($30/year), offering significantly more value. The free tier must be compelling enough to drive adoption (and road quality data collection), while premium features create clear upgrade motivation.

### 6.1 Revenue Projections (Year 1)

| Quarter | Downloads (cumulative) | MAU | Premium Conv. | MRR Estimate |
|---------|----------------------|-----|---------------|--------------|
| Q1 2027 (Launch) | 10,000 | 3,000 | 5% | €1,250 |
| Q2 2027 | 30,000 | 10,000 | 7% | €4,375 |
| Q3 2027 (Season) | 80,000 | 30,000 | 9% | €16,875 |
| Q4 2027 | 120,000 | 25,000 | 10% | €15,625 |

---

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Cold start: no road data at launch** | High | High | Pre-seed data by partnering with cycling/driving communities. Organize beta rider campaigns in key regions. Import OpenStreetMap surface tags where available. |
| Battery drain from sensors | Medium | Medium | Optimize sampling rate (reduce when on straight roads). Batch upload data on Wi-Fi. Provide battery usage dashboard to users. |
| Accelerometer accuracy varies by phone | Medium | High | Calibration routine on first use. ML model trained on diverse phone models. Aggregate multiple readings to smooth out device variance. |
| Competitor copies the feature | Medium | Medium | First-mover advantage + network effect. The more riders, the better the data — hard to replicate. Patent core algorithms where possible. |
| Privacy concerns with location tracking | High | Low | Data anonymized before upload. No personal identifiers attached to road quality data. Clear opt-in consent. GDPR/privacy-by-design from day one. |
| Map licensing costs at scale | Medium | Medium | Use open-source MapLibre + OpenStreetMap. Custom tile server. No dependency on Google Maps pricing. |

---

## 8. Next Steps

| # | Action Item | Owner | Due Date | Status |
|---|-------------|-------|----------|--------|
| 1 | Validate road quality ML model with test rides (3 phone models, 5 road types) | Tech Lead | May 2026 | Not Started |
| 2 | Create interactive wireframes for core flows (trip planner, ride mode, road quality overlay) | Design Lead | May 2026 | ✅ Done |
| 3 | Set up backend infrastructure (PostGIS, tile server, API scaffold) | Backend Dev | June 2026 | Not Started |
| 4 | Beta rider recruitment (target: 200 riders in CZ/SK region) | Product | June 2026 | Not Started |
| 5 | Legal review: privacy policy, GDPR compliance, location data handling | Legal | July 2026 | Not Started |
| 6 | MVP feature-complete build | Engineering | Oct 2026 | Not Started |
| 7 | Closed beta launch (CZ/SK/AT) | Product | Nov 2026 | Not Started |
| 8 | Public launch on App Store & Google Play | All | Q1 2027 | Not Started |

---

*End of Document*

**Tarmoto — Know the road before you ride it.**
