#!/usr/bin/env python3
"""
Tarmoto — Web Interface GitHub Issues
======================================

Creates GitHub Issues for the Tarmoto Web Companion (Section 9 of PRD).
34 user stories (US-31 → US-64) + 6 infrastructure tasks = 40 issues.

Targets the GetTarmoto/web repo. Uses the same milestone/phase structure
as the mobile issues in GetTarmoto/tarmoto.

Usage:
  1. Create a GitHub Personal Access Token:
     https://github.com/settings/tokens → Generate new token → scope: repo
  2. Set environment variable:
     export GITHUB_TOKEN=ghp_your_token_here
  3. Run:
     python create_web_issues.py            # creates everything
     python create_web_issues.py --dry-run  # preview without creating
"""

import os
import time

try:
    import requests
except ImportError:
    os.system("pip install requests --break-system-packages -q")
    import requests

OWNER = "GetTarmoto"
REPO = "web"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"

# ── Labels ──
# New web-specific epic labels + reuse of shared labels
LABELS = [
    # Web epic labels
    {"name": "epic:web-trip-planner", "color": "F97316", "description": "WEB-EPIC 1: Trip Planner (Desktop-First)"},
    {"name": "epic:web-road-explorer", "color": "22C55E", "description": "WEB-EPIC 2: Road Quality Explorer"},
    {"name": "epic:web-ride-history", "color": "3B82F6", "description": "WEB-EPIC 3: Ride History & Analytics"},
    {"name": "epic:web-community", "color": "EC4899", "description": "WEB-EPIC 4: Community Hub"},
    {"name": "epic:web-account", "color": "8B5CF6", "description": "WEB-EPIC 5: Account & Settings"},
    # Platform label
    {"name": "platform:web", "color": "0ED3CF", "description": "Web companion app (Next.js)"},
    # Priority labels (same as mobile)
    {"name": "priority:P0", "color": "EF4444", "description": "Critical — MVP must-have"},
    {"name": "priority:P1", "color": "F97316", "description": "High — MVP important"},
    {"name": "priority:P2", "color": "EAB308", "description": "Medium — Post-MVP"},
    {"name": "priority:P3", "color": "6B7280", "description": "Nice to have — Future"},
    # Type labels (same as mobile)
    {"name": "type:feature", "color": "0ED3CF", "description": "New feature"},
    {"name": "type:infra", "color": "475569", "description": "Infrastructure / DevOps"},
    {"name": "type:research", "color": "A78BFA", "description": "Research / Spike"},
    # Phase labels (same as mobile)
    {"name": "phase:mvp-1", "color": "22C55E", "description": "MVP Phase 1 (Q3-Q4 2026)"},
    {"name": "phase:mvp-2", "color": "3B82F6", "description": "MVP Phase 2 (Q1-Q2 2027)"},
    {"name": "phase:3", "color": "6B7280", "description": "Phase 3 (Q3 2027+)"},
]

# ── Milestones ──
MILESTONES = [
    {"title": "Web Alpha", "description": "Next.js scaffold, auth, MapLibre, basic trip planner. Target: Q3 2026", "due_on": "2026-09-30T00:00:00Z"},
    {"title": "Web MVP", "description": "Full trip planner, road quality explorer, account management. Target: Q4 2026", "due_on": "2026-12-31T00:00:00Z"},
    {"title": "Web Phase 2", "description": "Ride history, analytics, community hub. Target: Q2 2027", "due_on": "2027-06-30T00:00:00Z"},
    {"title": "Web Phase 3", "description": "Embeddable widgets, API docs portal, advanced analytics. Target: Q3 2027+", "due_on": "2027-12-31T00:00:00Z"},
]

# ── Issues ──
ISSUES = [

    # ═══════════════════════════════════════════════════════
    # WEB-EPIC 1: Trip Planner (Desktop-First)
    # ═══════════════════════════════════════════════════════

    {
        "title": "US-31: Full-screen Fun Zone discovery map",
        "body": "**As a rider**, I want to open a full-screen map and draw a region of interest so that I can discover Fun Zones (high-value road clusters) within that area.\n\n**Acceptance criteria:**\n- Full-screen MapLibre GL JS canvas with road quality heatmap\n- Draw polygon/rectangle region tool\n- Fun Zone clusters highlighted with composite score\n- Click zone to see top roads, curviness, elevation profile\n- Zoom/pan with smooth performance",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-32: Drag-and-drop route builder",
        "body": "**As a rider**, I want to drag-and-drop waypoints on the map and see the route auto-adjust through the best road segments so that route building feels intuitive and visual.\n\n**Acceptance criteria:**\n- Click to add waypoints, drag to reorder\n- Route auto-calculates through highest-quality segments\n- Waypoint snapping to road network\n- Distance and duration updates in real-time\n- Undo/redo support",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-33: Road Preview Cards sidebar",
        "body": "**As a rider**, I want a sidebar showing Road Preview Cards for each segment of my planned route (surface quality score, curviness rating, elevation profile, street-level photos, active hazards) so that I can evaluate every section without leaving the planner.\n\n**Acceptance criteria:**\n- Scrollable sidebar with one card per segment\n- Each card: quality score (1-5), curviness rating, elevation mini-chart, photo thumbnails, hazard count\n- Click card → map zooms to that segment\n- Expand card for full detail (trend graph, hazard list, rider photos)\n- Card highlights on map hover",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-34: AI multi-day itinerary generator",
        "body": "**As a rider**, I want to set trip parameters (number of days, daily km target, road type preference, avoidance criteria) and click \"Generate\" to receive an AI-optimized multi-day itinerary so that planning takes minutes, not hours.\n\n**Acceptance criteria:**\n- Parameter panel: days (1-14), daily km (100-500), road type (curvy/scenic/mixed), surface preference, avoidance (highways, tolls, unpaved)\n- Generate button produces multi-day route in < 10s\n- Each day: route on map, distance, elevation, estimated time, overnight stop\n- Regenerate individual days without affecting others\n- Compare multiple generated options side-by-side",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-35: Collaborative trip planning",
        "body": "**As a group leader**, I want to share a trip link with my riding group, where each member can suggest alternative road segments, add waypoints, and vote on route options so that planning is collaborative.\n\n**Acceptance criteria:**\n- Shareable trip invite link (no account required to view, account required to edit)\n- Real-time cursors showing collaborators on the map\n- Suggest alternative segment: draws on map, visible to all\n- Vote on suggestions: thumbs up/down per member\n- Group leader can accept/reject suggestions\n- Activity log showing who changed what",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-36: Accommodation and fuel stop suggestions",
        "body": "**As a rider**, I want the planner to suggest accommodations, fuel stops, and points of interest near Fun Zones and along the route so that logistics fit around the riding.\n\n**Acceptance criteria:**\n- Auto-suggest overnight stops near day-end waypoints\n- Fuel station markers along route with distance-to-empty warnings\n- POI layer: viewpoints, restaurants, bike-friendly cafés\n- Filter by type, rating, price range\n- Click to see details, add to itinerary",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-37: Trip drafts, folders, and management",
        "body": "**As a rider**, I want to save multiple trip drafts, duplicate and modify existing trips, and organize trips into folders so that I can manage my plans over time.\n\n**Acceptance criteria:**\n- Save/load trip drafts with auto-save\n- Duplicate trip to create variant\n- Organize into folders (e.g., \"Summer 2026 Alps\")\n- Search and filter saved trips\n- Trip metadata: name, dates, riders, status (draft/planned/completed)",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-38: GPX/KML import with quality overlay",
        "body": "**As a rider**, I want to import GPX/KML files into the planner and see them overlaid with road quality data so that I can evaluate routes from other sources.\n\n**Acceptance criteria:**\n- Drag-and-drop GPX/KML file onto map\n- Route rendered with road quality color coding\n- Segment-by-segment quality breakdown\n- Option to adopt as new trip draft\n- Support for Calimoto, Kurviger, Scenic, Garmin exports",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-39: Route export (GPX, link, push to mobile)",
        "body": "**As a rider**, I want to export my planned route as GPX for Garmin devices, as a shareable link, or push it directly to the Tarmoto mobile app so that the transition from planning to riding is seamless.\n\n**Acceptance criteria:**\n- Export as GPX file download\n- Shareable public/private link with map preview\n- Push to Tarmoto mobile app (appears in \"My Trips\")\n- Print-friendly route summary with turn list",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-40: Seasonal closures and construction zones",
        "body": "**As a rider**, I want to see seasonal road closures, mountain pass status, and construction zones on the planner map so that I don't plan trips around unavailable roads.\n\n**Acceptance criteria:**\n- Road closure markers with date ranges\n- Mountain pass open/closed status (sourced from official APIs where available)\n- Active construction zones with detour info\n- Warning when planned route crosses a closed road\n- Seasonal filter: show conditions for specific month",
        "labels": ["epic:web-trip-planner", "platform:web", "priority:P2", "type:feature", "phase:mvp-1"],
    },

    # ═══════════════════════════════════════════════════════
    # WEB-EPIC 2: Road Quality Explorer
    # ═══════════════════════════════════════════════════════

    {
        "title": "US-41: Public road quality heatmap (no login required)",
        "body": "**As a visitor** (no account required), I want to browse a full-screen road quality heatmap so that I can see road conditions in any region.\n\n**Acceptance criteria:**\n- Accessible without login (public page)\n- Full-screen MapLibre GL JS with road quality overlay\n- Color-coded segments: green (excellent) → red (very poor)\n- Zoom from country level to individual road\n- Fast tile loading via CDN\n- SEO-friendly URL structure (/explore/czech-republic/beskydy)",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-42: Road segment detail panel",
        "body": "**As a rider**, I want to click any road segment and see a detail panel (quality score, surface type, confidence level, number of rider passes, last updated, trend over time, photos) so that I get a complete picture of road conditions.\n\n**Acceptance criteria:**\n- Click segment → slide-out detail panel\n- Quality score (1-5) with confidence indicator\n- Surface type: asphalt / concrete / cobblestone / gravel / dirt\n- Number of unique rider passes\n- Last updated timestamp\n- Trend mini-chart (quality over last 6 months)\n- Community photos attached to segment",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-43: Map filters (quality, surface, curviness)",
        "body": "**As a rider**, I want to filter the map by quality tier, surface type, and curviness rating so that I find exactly the kind of roads I'm looking for.\n\n**Acceptance criteria:**\n- Quality filter: checkboxes for Excellent / Good / Fair / Poor / Very Poor\n- Surface filter: asphalt / concrete / cobblestone / gravel / dirt\n- Curviness filter: slider from straight to very twisty\n- Filters combine (AND logic)\n- Non-matching roads dimmed, not hidden\n- Filter state preserved in URL for sharing",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-44: Active hazard markers on explorer map",
        "body": "**As a rider**, I want to see active hazard markers on the map with details (type, reporter, time, confirmations) so that I can check current dangers before heading out.\n\n**Acceptance criteria:**\n- Hazard icons by type (pothole, gravel, oil, roadworks, etc.)\n- Click marker → popup with details, reporter, timestamp, confirmation count\n- Time-decay visualization (fading opacity as hazard ages)\n- Filter by hazard type\n- Cluster markers at low zoom levels",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-45: Road quality trend graph",
        "body": "**As a rider**, I want to view a road quality trend graph for any segment (how quality has changed over months/years) so that I can see if a road is deteriorating or recently repaired.\n\n**Acceptance criteria:**\n- Line chart showing quality score over time\n- Data points from aggregated rider passes\n- Highlight significant changes (repair detected, deterioration)\n- Comparison overlay: this segment vs regional average\n- Date range selector",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P2", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-46: Auto-generated \"Best Roads\" pages (SEO)",
        "body": "**As a visitor**, I want curated \"Best Roads\" pages (e.g., \"Best Roads in Beskydy\", \"Top 10 Alpine Passes\") auto-generated from community data so that I discover great rides through search engines.\n\n**Acceptance criteria:**\n- Server-side rendered pages (Next.js SSR)\n- Auto-generated from top-scoring segments per region\n- Structured data markup (Schema.org) for Google rich results\n- Each page: map, ranked road list, quality scores, curviness, photos\n- Region hierarchy: country → region → sub-region\n- Updated weekly from latest community data\n- CTA: \"Plan a trip with these roads\" → trip planner",
        "labels": ["epic:web-road-explorer", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },

    # ═══════════════════════════════════════════════════════
    # WEB-EPIC 3: Ride History & Analytics Dashboard
    # ═══════════════════════════════════════════════════════

    {
        "title": "US-47: Ride history with map and list view",
        "body": "**As a rider**, I want to see all my past rides on a map with filterable list view (by date, distance, duration, road quality encountered) so that I can browse my riding history.\n\n**Acceptance criteria:**\n- Map view: all ride tracks overlaid, click to select\n- List view: sortable table with date, distance, duration, avg quality\n- Filter by date range, distance, road quality\n- Search by ride name or location\n- Pagination for large ride libraries",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P1", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-48: Detailed ride view with stats and playback",
        "body": "**As a rider**, I want to click any ride and see a detailed view: route on map, elevation profile, speed graph, road quality breakdown per segment, and ride stats so that I can relive and analyze my rides.\n\n**Acceptance criteria:**\n- Route on map with road quality color coding\n- Elevation profile chart (interactive, click to jump on map)\n- Speed over time graph\n- Road quality breakdown: % excellent / good / fair / poor\n- Stats summary: distance, time, avg speed, max speed, elevation gain\n- Lean angle chart (if recorded)\n- Photo gallery from ride",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P1", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-49: Riding stats dashboard with trends",
        "body": "**As a rider**, I want a stats dashboard showing my all-time totals, monthly/yearly trends, and comparative charts so that I can track my riding over time.\n\n**Acceptance criteria:**\n- All-time totals: km, rides, hours, elevation, roads discovered\n- Monthly/yearly bar charts for distance and rides\n- Calendar heatmap showing riding days\n- Year-over-year comparison\n- Filterable by bike, ride type, region",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P1", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-50: Personal road map (ridden vs unridden)",
        "body": "**As a rider**, I want a personal road map — a map overlay showing every road I've ridden (highlighted) vs. roads I haven't (dimmed) — so that I'm motivated to explore new areas.\n\n**Acceptance criteria:**\n- Map layer: ridden roads in Tarmoto Cyan, unridden dimmed\n- Region exploration percentage (e.g., \"42% of Beskydy explored\")\n- Nearby unridden roads suggestions\n- Share exploration stats as image\n- Filter by time period",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-51: Side-by-side ride comparison",
        "body": "**As a rider**, I want to compare two rides side-by-side (same route at different times, or two different routes) so that I can see how conditions or my riding changed.\n\n**Acceptance criteria:**\n- Select two rides from library\n- Split-screen map view with synced zoom/pan\n- Overlay stats comparison table\n- Elevation profiles aligned\n- Road quality changes highlighted (improved/deteriorated)",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-52: Ride data export (CSV, GPX, API)",
        "body": "**As a rider**, I want to export my ride data as CSV, GPX, or via the API so that I can use it in other tools.\n\n**Acceptance criteria:**\n- Export individual ride as GPX\n- Export ride stats as CSV\n- Bulk export all rides\n- API access for Pro tier users\n- GDPR data export includes all ride data",
        "labels": ["epic:web-ride-history", "platform:web", "priority:P1", "type:feature", "phase:mvp-2"],
    },

    # ═══════════════════════════════════════════════════════
    # WEB-EPIC 4: Community Hub
    # ═══════════════════════════════════════════════════════

    {
        "title": "US-53: Community route and ride feed",
        "body": "**As a rider**, I want to browse a feed of shared routes and rides from the community, filterable by region, distance, curviness, road quality, and popularity so that I discover new roads.\n\n**Acceptance criteria:**\n- Feed of public rides and routes with map previews\n- Filter by region (map-based or text search)\n- Filter by distance, curviness, road quality, popularity\n- Sort by: newest, most popular, highest rated, nearest\n- Card preview: mini-map, stats, quality score, rider info",
        "labels": ["epic:web-community", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-54: Rider profiles",
        "body": "**As a rider**, I want to view other riders' public profiles (rides shared, roads discovered, badges earned, route collections) so that I can follow riders with good taste in roads.\n\n**Acceptance criteria:**\n- Public profile page: avatar, bio, bikes, home region\n- Stats: rides shared, km ridden, roads discovered\n- Badge showcase\n- Route collections by this rider\n- Follow/unfollow button\n- Activity feed of recent shared rides",
        "labels": ["epic:web-community", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-55: Road segment reviews with photos",
        "body": "**As a rider**, I want to rate and write reviews for road segments with photo uploads so that I help the community database grow beyond sensor data.\n\n**Acceptance criteria:**\n- Rate segment 1-5 stars\n- Write text review (max 500 chars)\n- Upload up to 5 photos per review\n- Reviews visible in road segment detail panel\n- Helpful/not helpful voting on reviews\n- Review moderation queue",
        "labels": ["epic:web-community", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-56: Route collections",
        "body": "**As a rider**, I want to create and share route collections (e.g., \"My Favorite Beskydy Loops\", \"Best Gravel Roads in Moravia\") so that I can curate recommendations.\n\n**Acceptance criteria:**\n- Create named collection with description\n- Add routes from ride history or community\n- Public/private visibility toggle\n- Collection page with map showing all routes\n- Share link for collection",
        "labels": ["epic:web-community", "platform:web", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-57: Gamification dashboard",
        "body": "**As a rider**, I want to see a gamification dashboard with my badges, active challenges, leaderboard position, and progress toward next milestones so that I stay engaged.\n\n**Acceptance criteria:**\n- Badge grid: earned (full color) vs locked (greyed)\n- Active challenges with progress bars\n- Regional leaderboard (km, roads discovered, hazards reported)\n- Next milestone preview with requirements\n- Seasonal challenge banner",
        "labels": ["epic:web-community", "platform:web", "priority:P3", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-58: Embeddable route and quality widgets",
        "body": "**As a rider**, I want to embed a route or road quality widget on external sites (forums, blogs) so that I can share Tarmoto data outside the app.\n\n**Acceptance criteria:**\n- Embed code generator (iframe) for routes\n- Embed code for road quality mini-map of a region\n- Responsive sizing\n- Tarmoto branding with \"View full map\" link\n- Embed analytics (views, clicks)",
        "labels": ["epic:web-community", "platform:web", "priority:P3", "type:feature", "phase:3"],
    },

    # ═══════════════════════════════════════════════════════
    # WEB-EPIC 5: Account & Settings
    # ═══════════════════════════════════════════════════════

    {
        "title": "US-59: Account creation and profile management",
        "body": "**As a user**, I want to create an account (email or social login), manage my profile (display name, avatar, bike info, home region), and link my mobile app so that my data syncs across platforms.\n\n**Acceptance criteria:**\n- Email + password registration\n- Social login: Google, Apple\n- Profile editor: name, avatar upload, bio, home region\n- Mobile app linking via QR code or login\n- Data sync confirmation between web and mobile",
        "labels": ["epic:web-account", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-60: Subscription management",
        "body": "**As a user**, I want to manage my subscription tier (Free/Premium/Pro), view billing history, and update payment methods so that I control my account from the web.\n\n**Acceptance criteria:**\n- Current plan display with feature comparison\n- Upgrade/downgrade flow\n- Billing history with invoice downloads\n- Payment method management (Stripe integration)\n- Cancel subscription with retention offer",
        "labels": ["epic:web-account", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-61: Privacy settings and data controls",
        "body": "**As a user**, I want to configure my privacy settings (profile visibility, ride sharing defaults, road data contribution opt-in/out, location data retention) so that I control what I share.\n\n**Acceptance criteria:**\n- Profile visibility: public / riders-only / private\n- Default ride sharing: public / private\n- Road data contribution: opt-in toggle with explanation\n- Location data retention period selector\n- Data processing consent management",
        "labels": ["epic:web-account", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-62: GDPR data export and account deletion",
        "body": "**As a user**, I want to export all my data (rides, routes, profile) or delete my account and all associated data so that Tarmoto complies with GDPR.\n\n**Acceptance criteria:**\n- \"Download my data\" button → generates ZIP with all user data\n- Data export includes: rides (GPX + stats), routes, profile, reviews, hazard reports\n- \"Delete my account\" flow with confirmation\n- Account deletion removes all personal data within 30 days\n- Anonymized road quality contributions retained (no PII)\n- Confirmation email for both actions",
        "labels": ["epic:web-account", "platform:web", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-63: Notification preferences",
        "body": "**As a user**, I want to manage notification preferences (email digests, hazard alerts for saved routes, community activity) so that I only receive relevant communications.\n\n**Acceptance criteria:**\n- Email digest: daily / weekly / never\n- Hazard alerts for saved routes: on/off\n- Community notifications: new followers, route comments, ride likes\n- Marketing emails: opt-in only\n- Per-channel toggles with clear descriptions",
        "labels": ["epic:web-account", "platform:web", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-64: Bike garage management",
        "body": "**As a user**, I want to manage my bikes (make, model, year) and set the active bike so that ride stats and recommendations are bike-aware.\n\n**Acceptance criteria:**\n- Add multiple bikes with make/model/year\n- Set active bike (default for new rides)\n- Bike-specific stats (total km, rides per bike)\n- Bike photo upload\n- Synced with mobile app",
        "labels": ["epic:web-account", "platform:web", "priority:P2", "type:feature", "phase:mvp-1"],
    },

    # ═══════════════════════════════════════════════════════
    # Infrastructure Tasks
    # ═══════════════════════════════════════════════════════

    {
        "title": "INFRA: Scaffold Next.js project",
        "body": "**Technical task:** Initialize the Next.js web application.\n\n- Next.js 14+ with App Router\n- TypeScript strict mode\n- Tailwind CSS configuration\n- ESLint + Prettier setup\n- Folder structure: `/app` (routes), `/components`, `/lib`, `/hooks`, `/types`\n- Environment variable management (.env.local)\n- CI/CD pipeline (GitHub Actions → Vercel/Cloudflare Pages)",
        "labels": ["platform:web", "priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Authentication integration (NextAuth.js + shared JWT)",
        "body": "**Technical task:** Set up shared authentication between web and mobile.\n\n- NextAuth.js with email + Google + Apple providers\n- JWT tokens compatible with NestJS backend\n- Session management\n- Protected route middleware\n- Auth state in Zustand store\n- Login/register/forgot-password pages",
        "labels": ["platform:web", "priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: MapLibre GL JS integration + tile pipeline",
        "body": "**Technical task:** Set up the map engine for the web app.\n\n- MapLibre GL JS with custom Tarmoto style\n- Road quality vector tile layer (same tiles as mobile)\n- Custom controls: zoom, locate, layer toggles\n- Drawing tools (polygon, rectangle) for trip planner\n- Performance optimization for large tile sets\n- Dark mode map style variant",
        "labels": ["platform:web", "priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: API client from OpenAPI spec",
        "body": "**Technical task:** Generate type-safe API client from NestJS backend.\n\n- Auto-generate TypeScript client from NestJS OpenAPI/Swagger spec\n- Tool: `openapi-typescript-codegen` or `orval`\n- Shared types package between web and mobile\n- API error handling + retry logic\n- Request/response interceptors (auth headers, error toasts)\n- CI step: regenerate client on spec changes",
        "labels": ["platform:web", "priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Real-time WebSocket client",
        "body": "**Technical task:** Set up WebSocket connection for real-time features.\n\n- Socket.io client connecting to shared NestJS WebSocket gateway\n- Collaborative trip planning: cursor sync, live edits\n- Hazard alert feed: new hazards appear on map in real-time\n- Connection management: reconnect on drop, offline indicator\n- Zustand integration for real-time state",
        "labels": ["platform:web", "priority:P1", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Stripe payment integration",
        "body": "**Technical task:** Set up subscription payments for web.\n\n- Stripe Checkout for new subscriptions\n- Stripe Customer Portal for management\n- Webhook handler for payment events (via NestJS backend)\n- Plan display component with feature comparison\n- Receipt/invoice generation\n- Trial period support",
        "labels": ["platform:web", "priority:P1", "type:infra", "phase:mvp-1"],
    },
]


def create_github_issues():
    """Create all issues via GitHub API."""
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        print("Error: Set GITHUB_TOKEN environment variable")
        print("  export GITHUB_TOKEN=ghp_your_token_here")
        sys.exit(1)

    headers = {
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json',
    }

    # Create labels
    print("\nCreating labels...")
    for label in LABELS:
        r = requests.post(f"{API}/labels", json=label, headers=headers)
        if r.status_code == 201:
            print(f"  ✅ Label: {label['name']}")
        elif r.status_code == 422:
            print(f"  ⏭  Label exists: {label['name']}")
        else:
            print(f"  ❌ Label failed: {label['name']} — {r.status_code}")

    # Create milestones
    print("\nCreating milestones...")
    milestone_map = {}
    for ms in MILESTONES:
        r = requests.post(f"{API}/milestones", json=ms, headers=headers)
        if r.status_code == 201:
            milestone_map[ms['title']] = r.json()['number']
            print(f"  ✅ Milestone: {ms['title']}")
        elif r.status_code == 422:
            existing = requests.get(f"{API}/milestones", headers=headers).json()
            for e in existing:
                if e['title'] == ms['title']:
                    milestone_map[ms['title']] = e['number']
            print(f"  ⏭  Milestone exists: {ms['title']}")

    # Create issues
    print(f"\nCreating {len(ISSUES)} issues...")
    for issue in ISSUES:
        # Map phase labels to milestones
        milestone = None
        for label in issue.get('labels', []):
            if 'mvp-1' in label:
                milestone = milestone_map.get('Web MVP')
            elif 'mvp-2' in label:
                milestone = milestone_map.get('Web Phase 2')
            elif 'phase:3' in label:
                milestone = milestone_map.get('Web Phase 3')

        payload = {
            'title': issue['title'],
            'body': issue['body'],
            'labels': issue['labels'],
        }
        if milestone:
            payload['milestone'] = milestone

        r = requests.post(f"{API}/issues", json=payload, headers=headers)
        if r.status_code == 201:
            print(f"  ✅ #{r.json()['number']}: {issue['title']}")
        else:
            print(f"  ❌ Failed: {issue['title']} — {r.status_code} {r.text[:100]}")

        time.sleep(0.5)  # Rate limit

    print(f"\n✅ Done! Created {len(ISSUES)} issues with labels and milestones.\n")


if __name__ == '__main__':
    import sys
    if '--dry-run' in sys.argv:
        print(f"\nDRY RUN — {len(ISSUES)} issues would be created:\n")
        for i, issue in enumerate(ISSUES, 1):
            labels = ', '.join(issue['labels'])
            print(f"  {i:2d}. {issue['title']}")
            print(f"      Labels: {labels}\n")

        print(f"\nLabels to create: {len(LABELS)}")
        for l in LABELS:
            print(f"  • {l['name']} — {l['description']}")

        print(f"\nMilestones to create: {len(MILESTONES)}")
        for m in MILESTONES:
            print(f"  • {m['title']} (due: {m['due_on'][:10]})")

        print(f"\n── Summary ──")
        print(f"  Issues:     {len(ISSUES)} ({len([i for i in ISSUES if 'type:feature' in i['labels']])} features + {len([i for i in ISSUES if 'type:infra' in i['labels']])} infra)")
        print(f"  Labels:     {len(LABELS)}")
        print(f"  Milestones: {len(MILESTONES)}")
        print(f"  Target:     {OWNER}/{REPO}")
    else:
        create_github_issues()
