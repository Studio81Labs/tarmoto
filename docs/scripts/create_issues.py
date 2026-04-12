#!/usr/bin/env python3
"""
Tarmoto — GitHub Issues Creator

Creates GitHub Issues from PRD user stories and tasks.

Usage:
  1. Create a GitHub Personal Access Token:
     https://github.com/settings/tokens → Generate new token → scope: repo
  2. Set environment variable:
     export GITHUB_TOKEN=ghp_your_token_here
  3. Run:
     python create_issues.py

Or import manually by copy-pasting from the ISSUES list below.
"""

import os
import json
import sys
import time

try:
    import requests
except ImportError:
    os.system("pip install requests --break-system-packages -q")
    import requests

OWNER = "GetTarmoto"
REPO = "tarmoto"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"

# ── Labels to create first ──
LABELS = [
    {"name": "epic:road-quality", "color": "22C55E", "description": "Epic 1: Road Surface Intelligence"},
    {"name": "epic:trip-planner", "color": "F97316", "description": "Epic 2: Smart Multi-Day Trip Planner"},
    {"name": "epic:safety", "color": "EF4444", "description": "Epic 3: Real-Time Safety & Alerts"},
    {"name": "epic:navigation", "color": "3B82F6", "description": "Epic 4: Navigation & Ride Tracking"},
    {"name": "epic:commute", "color": "8B5CF6", "description": "Epic 5: Commuter Mode"},
    {"name": "epic:community", "color": "EC4899", "description": "Epic 6: Community & Social"},
    {"name": "epic:gamification", "color": "6B7280", "description": "Epic 7: Gamification & Engagement"},
    {"name": "priority:P0", "color": "EF4444", "description": "Critical — MVP must-have"},
    {"name": "priority:P1", "color": "F97316", "description": "High — MVP important"},
    {"name": "priority:P2", "color": "EAB308", "description": "Medium — Post-MVP"},
    {"name": "priority:P3", "color": "6B7280", "description": "Nice to have — Future"},
    {"name": "type:feature", "color": "0ED3CF", "description": "New feature"},
    {"name": "type:infra", "color": "475569", "description": "Infrastructure / DevOps"},
    {"name": "type:research", "color": "A78BFA", "description": "Research / Spike"},
    {"name": "phase:mvp-1", "color": "22C55E", "description": "MVP Phase 1 (Q3-Q4 2026)"},
    {"name": "phase:mvp-2", "color": "3B82F6", "description": "MVP Phase 2 (Q1-Q2 2027)"},
    {"name": "phase:3", "color": "6B7280", "description": "Phase 3 (Q3 2027+)"},
]

# ── Milestones ──
MILESTONES = [
    {"title": "Phase 1: MVP", "description": "Core app with surface quality, trip planning, safety, navigation. Target: Q4 2026", "due_on": "2026-12-31T00:00:00Z"},
    {"title": "Phase 2: Growth", "description": "Commuter mode, community & social features. Target: Q2 2027", "due_on": "2027-06-30T00:00:00Z"},
    {"title": "Phase 3: Engagement", "description": "Gamification, advanced analytics, API. Target: Q3 2027+", "due_on": "2027-12-31T00:00:00Z"},
]

# ── Issues ──
ISSUES = [
    # ── Epic 1: Road Surface Intelligence ──
    {
        "title": "US-1: Road quality overlay on map",
        "body": "**As a rider**, I want to see a road quality overlay on the map so that I can avoid roads with poor asphalt before I ride them.\n\n**Acceptance criteria:**\n- Color-coded road segments (green/yellow/orange/red)\n- Toggle overlay on/off\n- Quality shown at all zoom levels\n- Works offline with cached tiles",
        "labels": ["epic:road-quality", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-2: Automatic road surface data recording",
        "body": "**As a rider**, I want my phone to automatically record road surface data while I ride so that I contribute to the community without any extra effort.\n\n**Acceptance criteria:**\n- Accelerometer sampling at 50Hz in background\n- GPS linking to each measurement window\n- Battery-optimized (< 5% additional drain)\n- Opt-in consent with clear explanation",
        "labels": ["epic:road-quality", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-3: Road Quality Score per segment",
        "body": "**As a rider**, I want to see a Road Quality Score (1–5) for each road segment so that I can quickly assess if a road is worth riding.\n\n**Acceptance criteria:**\n- Score displayed on map tap\n- Score in route planning results\n- Confidence indicator (based on number of readings)\n- Last updated timestamp",
        "labels": ["epic:road-quality", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-4: One-tap hazard reporting",
        "body": "**As a rider**, I want to report specific hazards (pothole, gravel, oil spill) with a single tap so that other riders are warned immediately.\n\n**Acceptance criteria:**\n- Large glove-friendly tap targets\n- Hazard types: pothole, gravel, oil, roadworks, animals, police, flooding, ice\n- Optional severity and note\n- Auto-expire after 24-72h unless confirmed",
        "labels": ["epic:road-quality", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-5: Filter routes by minimum road quality",
        "body": "**As a route planner**, I want to filter routes by minimum road quality so that I only see routes with good asphalt.\n\n**Acceptance criteria:**\n- Quality threshold slider in route settings\n- Routes below threshold shown in gray/excluded\n- Works in both single ride and trip planning",
        "labels": ["epic:road-quality", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Road quality ML pipeline",
        "body": "**Technical task:** Build the end-to-end road quality data pipeline.\n\n**Components:**\n- On-device TF Lite model for surface classification\n- Server-side aggregation pipeline (multiple riders → confidence score)\n- Vector tile generation for quality overlay\n- 100m segment granularity\n- Recency-weighted scoring (newer data > older)",
        "labels": ["epic:road-quality", "priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "RESEARCH: Validate accelerometer-based road classification",
        "body": "**Spike:** Collect labeled ride data on known roads and validate that accelerometer RMS reliably distinguishes road surface types.\n\n**Tasks:**\n- Test rides on smooth, rough, and gravel roads\n- Analyze RMS distributions per road type\n- Determine if clusters are separable\n- Calibrate classification thresholds\n- Test across 3+ phone models",
        "labels": ["epic:road-quality", "priority:P0", "type:research", "phase:mvp-1"],
    },

    # ── Epic 2: Smart Multi-Day Trip Planner ──
    {
        "title": "US-6: Region heatmap for fun zone discovery",
        "body": "**As a group leader**, I want to draw a region on the map and see a heatmap of the best roads so that I can plan our trip around fun zones.\n\n**Acceptance criteria:**\n- Draw/select region on map\n- Heatmap shows clusters of high-scoring roads\n- Fun Zone cards with composite score, road count, total curve km",
        "labels": ["epic:trip-planner", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-7: Auto-generated multi-day route",
        "body": "**As a rider**, I want to set trip parameters (days, daily km, road type preference) and get an auto-generated multi-day route.\n\n**Acceptance criteria:**\n- Input: start point, days, daily distance range, min quality, road preference\n- Output: optimized multi-day route maximizing fun-factor roads\n- Each day has reasonable distance and logical overnight stop\n- Fuel stops included",
        "labels": ["epic:trip-planner", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-8: Collaborative trip planning",
        "body": "**As a group member**, I want to join a shared trip, suggest road segments, and vote on alternatives.\n\n**Acceptance criteria:**\n- Invite via link/code\n- Real-time sync of route changes\n- Suggest/vote on road segments\n- In-trip chat\n- See all members' suggestions on map",
        "labels": ["epic:trip-planner", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-9: Road Preview Cards",
        "body": "**As a rider**, I want to see Road Preview Cards for every segment (surface quality, curviness, elevation, photos, hazards) so that I don't need to check Street View.\n\n**Acceptance criteria:**\n- Surface quality score + bar breakdown\n- Curviness score + curve count\n- Elevation profile\n- Known hazards\n- Recent rider reviews with photos\n- Bike model of reviewers",
        "labels": ["epic:trip-planner", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-10: Accommodation and fuel stop suggestions",
        "body": "**As a rider**, I want the app to suggest accommodations and fuel stops near the best riding zones.\n\n**Acceptance criteria:**\n- Fuel stops along route with distance warnings\n- Accommodation suggestions near day end points\n- POI integration (restaurants, viewpoints)",
        "labels": ["epic:trip-planner", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-11: Seasonal pass availability data",
        "body": "**As a rider**, I want to see seasonal/pass availability data so I don't plan a trip around a closed mountain pass.\n\n**Acceptance criteria:**\n- Known pass open/close dates\n- Current status indicator\n- Warning when route includes potentially closed passes",
        "labels": ["epic:trip-planner", "priority:P1", "type:feature", "phase:mvp-1"],
    },

    # ── Epic 3: Safety ──
    {
        "title": "US-12: Crash detection with emergency alerts",
        "body": "**As a rider**, I want crash detection that automatically alerts my emergency contacts if I'm in an accident.\n\n**Acceptance criteria:**\n- Accelerometer + GPS based crash detection\n- 60-second countdown to cancel false positives\n- SMS/call to emergency contacts with GPS location\n- Works without cell coverage (queued until signal)",
        "labels": ["epic:safety", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-13: Real-time weather alerts along route",
        "body": "**As a rider**, I want real-time weather alerts along my route so that I can reroute to avoid storms.\n\n**Acceptance criteria:**\n- Weather overlay on map\n- Alerts for rain, storms, ice along planned route\n- Suggest alternative routes to avoid weather",
        "labels": ["epic:safety", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-14: Community hazard alerts (Waze-style)",
        "body": "**As a rider**, I want Waze-style community hazard alerts (oil, gravel, roadworks, animals, police) so that I'm warned about dangers ahead.\n\n**Acceptance criteria:**\n- Voice/audio alert when approaching hazard\n- Visual indicator on map\n- Distance countdown to hazard\n- Confirm/dismiss to keep alerts accurate",
        "labels": ["epic:safety", "priority:P0", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-15: Proactive commute hazard warnings",
        "body": "**As a commuter**, I want the app to learn my usual route and proactively warn me about new hazards on my daily commute.\n\n**Acceptance criteria:**\n- Learns commute route after 3 rides\n- Push notification before ride if new hazard detected\n- Shows hazard diff since last commute",
        "labels": ["epic:safety", "priority:P1", "type:feature", "phase:mvp-1"],
    },

    # ── Epic 4: Navigation ──
    {
        "title": "US-16: Turn-by-turn voice navigation",
        "body": "**As a rider**, I want turn-by-turn voice navigation with motorcycle-specific instructions.\n\n**Acceptance criteria:**\n- Clear voice prompts via Bluetooth headset\n- Early warnings for turns (motorcycle-appropriate timing)\n- Road name announcements\n- Rerouting when off-track",
        "labels": ["epic:navigation", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-17: CarPlay and Android Auto support",
        "body": "**As a rider**, I want full CarPlay and Android Auto support from day one so that I can use my bike's display.\n\n**Acceptance criteria:**\n- Simplified map view for CarPlay/AA\n- Turn-by-turn on bike display\n- Basic ride stats visible\n- Voice control for hazard reporting",
        "labels": ["epic:navigation", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-18: Offline maps and navigation",
        "body": "**As a rider**, I want offline maps and navigation so that I can ride in areas without cell coverage.\n\n**Acceptance criteria:**\n- Download map regions for offline use\n- Full navigation works offline\n- Road quality overlay available offline\n- Sensor data queued for upload when back online",
        "labels": ["epic:navigation", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-19: Automatic ride tracking with stats",
        "body": "**As a rider**, I want automatic ride tracking with stats (distance, duration, elevation, lean angles, top speed).\n\n**Acceptance criteria:**\n- Auto-start/stop detection\n- Distance, duration, avg/max speed\n- Elevation gain/loss\n- Lean angle tracking\n- Ride saved to logbook",
        "labels": ["epic:navigation", "priority:P1", "type:feature", "phase:mvp-1"],
    },
    {
        "title": "US-20: GPX import/export",
        "body": "**As a rider**, I want GPX import/export so that I can use routes from other platforms.\n\n**Acceptance criteria:**\n- Import GPX files from Calimoto, Kurviger, etc.\n- Export routes as GPX\n- Transfer to Garmin GPS devices",
        "labels": ["epic:navigation", "priority:P1", "type:feature", "phase:mvp-1"],
    },

    # ── Epic 5: Commuter Mode ──
    {
        "title": "US-21: One-tap commute button",
        "body": "**As a commuter**, I want a one-tap \"Commute\" button that navigates my daily route with real-time hazard and traffic info.\n\n**Acceptance criteria:**\n- Learns home and work locations\n- One tap to start commute navigation\n- Shows route status (clear/hazards/delays)\n- Weather conditions displayed",
        "labels": ["epic:commute", "priority:P1", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-22: Alternative commute route suggestions",
        "body": "**As a commuter**, I want the app to suggest alternative routes when my usual commute has issues.\n\n**Acceptance criteria:**\n- Detect roadworks/accidents/weather on usual route\n- Suggest 1-2 alternatives with time/distance comparison\n- Alternative routes also show road quality",
        "labels": ["epic:commute", "priority:P1", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-23: Weekly commute summary",
        "body": "**As a commuter**, I want a weekly summary of my commute rides (time, distance, fuel estimate).\n\n**Acceptance criteria:**\n- Weekly stats card: rides, total km, total time, fuel estimate\n- Trend comparison vs previous week\n- Calendar view of commute days",
        "labels": ["epic:commute", "priority:P2", "type:feature", "phase:mvp-2"],
    },

    # ── Epic 6: Community ──
    {
        "title": "US-24: Share rides and routes",
        "body": "**As a rider**, I want to share my rides and routes with the community.\n\n**Acceptance criteria:**\n- Share ride with stats and route\n- Public/private toggle\n- Share link for non-users\n- Browse community rides nearby",
        "labels": ["epic:community", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-25: Rate and review road segments",
        "body": "**As a rider**, I want to rate and review road segments with photos.\n\n**Acceptance criteria:**\n- 1-5 star rating per segment\n- Text review with photos\n- Bike model field\n- Reviews visible on Road Preview Cards",
        "labels": ["epic:community", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-26: Live location sharing with riding group",
        "body": "**As a group rider**, I want real-time location sharing with my riding group.\n\n**Acceptance criteria:**\n- See all group members on map\n- Distance between riders shown\n- Alert when someone falls behind\n- Battery-optimized tracking",
        "labels": ["epic:community", "priority:P2", "type:feature", "phase:mvp-2"],
    },
    {
        "title": "US-27: Follow riders and see their routes",
        "body": "**As a rider**, I want to follow other riders and see their recommended routes in my area.\n\n**Acceptance criteria:**\n- Follow/unfollow riders\n- Feed of followed riders' routes\n- Filter by location/distance",
        "labels": ["epic:community", "priority:P2", "type:feature", "phase:mvp-2"],
    },

    # ── Epic 7: Gamification ──
    {
        "title": "US-28: Riding milestone badges",
        "body": "**As a rider**, I want to earn badges for riding milestones (km ridden, roads discovered, hazards reported).\n\n**Acceptance criteria:**\n- Badge system with tiers (bronze/silver/gold)\n- Categories: distance, exploration, community contribution\n- Profile display of earned badges",
        "labels": ["epic:gamification", "priority:P3", "type:feature", "phase:3"],
    },
    {
        "title": "US-29: Seasonal challenges",
        "body": "**As a rider**, I want seasonal challenges (e.g., \"Ride 10 new roads this month\") to motivate exploration.\n\n**Acceptance criteria:**\n- Monthly/seasonal challenge system\n- Progress tracking\n- Rewards (premium features, badges)\n- Leaderboard",
        "labels": ["epic:gamification", "priority:P3", "type:feature", "phase:3"],
    },
    {
        "title": "US-30: Personal road map (ridden vs unridden)",
        "body": "**As a rider**, I want a personal road map showing which roads I've ridden vs haven't, motivating me to explore new areas.\n\n**Acceptance criteria:**\n- Map visualization: ridden roads highlighted\n- Percentage of area explored\n- \"Nearby unridden roads\" suggestions\n- Share exploration stats",
        "labels": ["epic:gamification", "priority:P3", "type:feature", "phase:3"],
    },

    # ── Infrastructure tasks ──
    {
        "title": "INFRA: Set up React Native project with Expo",
        "body": "**Technical task:** Initialize the React Native project.\n\n- Expo managed workflow\n- TypeScript configuration\n- Navigation setup (React Navigation)\n- State management (Zustand or similar)\n- Map integration (MapLibre GL)\n- CI/CD pipeline (EAS Build)",
        "labels": ["priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Set up backend API (NestJS/FastAPI)",
        "body": "**Technical task:** Initialize the backend API.\n\n- API framework setup\n- PostgreSQL + PostGIS connection\n- JWT authentication\n- API documentation (OpenAPI/Swagger)\n- Docker configuration\n- CI/CD pipeline",
        "labels": ["priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: PostGIS database + schema migration",
        "body": "**Technical task:** Set up the production database.\n\n- PostgreSQL + PostGIS deployment\n- Apply schema from docs/schema.sql\n- Migration tooling (Flyway/Alembic)\n- Seed data: OSM road segments for CZ/SK region\n- Spatial indexes verified",
        "labels": ["priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Map tile server + quality overlay",
        "body": "**Technical task:** Set up vector tile serving.\n\n- MapLibre GL integration\n- Custom vector tiles from PostGIS\n- Road quality overlay layer\n- Offline tile caching\n- CDN for tile distribution",
        "labels": ["priority:P0", "type:infra", "phase:mvp-1"],
    },
    {
        "title": "INFRA: Real-time event system (WebSocket + Redis)",
        "body": "**Technical task:** Set up real-time infrastructure.\n\n- WebSocket server for live updates\n- Redis Pub/Sub for hazard alert broadcast\n- Group ride location sharing\n- Connection management + reconnection",
        "labels": ["priority:P1", "type:infra", "phase:mvp-1"],
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
            # Get existing
            existing = requests.get(f"{API}/milestones", headers=headers).json()
            for e in existing:
                if e['title'] == ms['title']:
                    milestone_map[ms['title']] = e['number']
            print(f"  ⏭  Milestone exists: {ms['title']}")

    # Create issues
    print(f"\nCreating {len(ISSUES)} issues...")
    for issue in ISSUES:
        # Map phase label to milestone
        milestone = None
        for label in issue.get('labels', []):
            if 'mvp-1' in label:
                milestone = milestone_map.get('Phase 1: MVP')
            elif 'mvp-2' in label:
                milestone = milestone_map.get('Phase 2: Growth')
            elif 'phase:3' in label:
                milestone = milestone_map.get('Phase 3: Engagement')

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
    if '--dry-run' in sys.argv:
        print(f"\nDRY RUN — {len(ISSUES)} issues would be created:\n")
        for i, issue in enumerate(ISSUES, 1):
            labels = ', '.join(issue['labels'])
            print(f"  {i:2d}. {issue['title']}")
            print(f"      Labels: {labels}\n")
    else:
        create_github_issues()
