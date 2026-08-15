# Companion App — Testing Scenarios

## Environment Matrix

| Dimension   | Coverage                                                |
| ----------- | ------------------------------------------------------- |
| Browsers    | Chrome 130+, Firefox 130+, Safari 18+, Edge 130+        |
| Viewports   | 1920x1080, 1440x900, 768x1024 (tablet), 390x844 (phone) |
| Auth states | Logged out, Free tier, Premium tier                     |
| Network     | Fast (100Mbps), slow 3G, offline                        |

## WEB-EPIC 1: Trip Planner (P0)

| #    | Scenario                   | Steps                                                   | Expected Result                                                    |
| ---- | -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| T1   | Open empty planner         | Navigate to `/trips/planner`                            | Full-screen map loads with road quality heatmap, empty route state |
| T2   | Draw region on map         | Use draw tool to outline a region                       | Fun Zone clusters appear within the region                         |
| T3   | Build route with waypoints | Click to add 3+ waypoints on map, drag to reorder       | Route auto-adjusts through best road segments                      |
| T4   | Segment sidebar            | Click route, expand Road Preview Card                   | Quality score, curviness, elevation profile, surface type, hazards |
| T5   | Trip parameters            | Open parameter panel, set days=3, km/day=300            | Parameters persist in URL, re-generate respects constraints        |
| T6   | Save trip draft            | Click Save, name the trip                               | Redirects to `/trips/[id]`, appears in trips list                  |
| T7   | Duplicate trip             | From trip detail, click Duplicate                       | New draft created with "(copy)" suffix                             |
| T8   | Edit existing trip         | Navigate to `/trips/[id]/edit`                          | Planner loads with existing route and waypoints                    |
| T9   | GPX import                 | Click Import, select .gpx file                          | Route overlays with road quality data merged                       |
| T10  | GPX export                 | Click Export > GPX                                      | Downloads .gpx file with waypoints and route geometry              |
| T11  | Share trip link            | Click Share, copy link                                  | Link opens trip view for authenticated group members               |
| T12  | Collaboration              | Open shared trip, drag waypoint, submit suggestion      | Other members see pending suggestion with accept/reject            |
| T13  | Closures visible           | Open planner in region with known seasonal closures     | Closed roads marked with icon, hover shows dates                   |
| T14a | Place start/end via menu   | Right-click map → "Set start here", then "Set end here" | Road-following route appears; map keeps current zoom               |
| T14b | Add via point              | With start+end set, right-click → "Add via here"        | Route threads through new point, re-snaps to roads                 |
| T14c | Drag to re-route           | Drag a waypoint pin                                     | Route recomputes live (debounced), stays on roads                  |
| T14d | Save live route            | Click Save with valid start→end route                   | Trip persists; reopening shows same road route, framed once        |
| T14e | Engine down (Valhalla)     | Stop Valhalla, edit a waypoint                          | Non-blocking error; last route retained; no crash                  |

## WEB-EPIC 2: Road Quality Explorer (P0)

| #   | Scenario               | Steps                                    | Expected Result                                                     |
| --- | ---------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| T15 | Public explorer        | Open `/explore` in incognito             | Full-screen heatmap loads, no auth gate                             |
| T16 | Click segment          | Click colored road segment               | Sidebar opens with quality score, surface type, confidence          |
| T17 | Segment trend chart    | Expand trend section                     | Line chart showing quality over time                                |
| T18 | Filter by quality      | Toggle quality tiers                     | Map updates to show only matching segments                          |
| T19 | Filter by surface type | Select "Gravel" filter                   | Only gravel roads highlighted                                       |
| T20 | Filter by curviness    | Set curviness slider                     | Only matching segments shown                                        |
| T21 | URL-synced filters     | Apply filters, copy URL, open in new tab | Filters restored from URL params                                    |
| T22 | Hazard markers         | Enable hazard layer, click marker        | Hazard type, reporter, time, confirmations                          |
| T23 | Best Roads page        | Navigate to `/roads/best/CZ`             | SSR page with curated list, SEO metadata                            |
| T24 | Legacy embed redirect  | Open `/embed/roads/cz/beskydy`           | 308 permanent redirect to `/roads/best/cz/beskydy` (embeds retired) |
| T25 | Road reviews           | Open segment sidebar, Reviews tab        | User reviews with ratings and photos                                |
| T26 | Submit review          | Write review, upload photo, submit       | Review appears, count increments                                    |
| T27 | Closures panel         | Open for region                          | Seasonal closures and construction zones listed                     |
| T28 | Passes panel           | Open for alpine region                   | Pass status with elevation data                                     |

## WEB-EPIC 3: Ride History & Analytics (P1)

| #    | Scenario                  | Steps                                                              | Expected Result                                                                                                                       |
| ---- | ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| T29  | Ride list                 | Navigate to `/rides`                                               | Paginated list with date, distance, duration, quality                                                                                 |
| T30  | Filter rides              | Filter by date range, min distance                                 | List updates, URL reflects filters                                                                                                    |
| T31  | Ride detail               | Click ride > `/rides/[id]`                                         | Route on map, elevation profile, speed graph, stats                                                                                   |
| T32  | Ride stats (Premium)      | Navigate to `/rides/stats` as a rider WITH `advanced_analytics`    | All-time totals, monthly trends, charts                                                                                               |
| T32b | Ride stats (not entitled) | Navigate to `/rides/stats` as a rider WITHOUT `advanced_analytics` | Page header stays; locked teaser with an upgrade CTA, NOT the "no rides recorded" empty state; no ride or breakdown request is issued |
| T33  | Personal road map         | Navigate to `/rides/road-map`                                      | Ridden roads highlighted, unridden dimmed                                                                                             |
| T34  | Compare rides             | Navigate to `/rides/compare`, select 2                             | Side-by-side with stats diff, dual map                                                                                                |
| T35  | Export ride data          | Click Export > CSV                                                 | Downloads CSV with segment data                                                                                                       |
| T36  | Shared ride               | Open `/rides/shared/[token]`                                       | Public ride view, no auth required                                                                                                    |

## WEB-EPIC 4: Community Hub (P2)

| #    | Scenario                   | Steps                                                                                  | Expected Result                                                                                                                         |
| ---- | -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| T37  | Community feed             | Navigate to `/community`                                                               | Feed of shared routes/rides, filterable                                                                                                 |
| T38  | Rider profile              | Click rider > `/community/[id]`                                                        | Profile with rides, roads discovered, badges                                                                                            |
| T39  | Collections list           | Navigate to `/community/collections`                                                   | Browse curated collections (empty state if none)                                                                                        |
| T40  | Collection detail          | Click collection > `/community/collections/[id]`                                       | Collection with route previews, follow button                                                                                           |
| T41  | Shared collection          | Open `/community/collections/shared/[slug]`                                            | Public view, no auth required                                                                                                           |
| T42  | Create collection          | Build route, Save as Collection                                                        | Collection appears in profile and community feed                                                                                        |
| T43  | Delete collection          | Delete from collection detail                                                          | App-styled confirmation dialog, collection removed                                                                                      |
| T44  | Gamification               | Navigate to `/gamification`                                                            | Badges, challenges, leaderboard, progress                                                                                               |
| T44a | Discover collection links  | On `/community/collections/discover/[slug]`, click the owner chip and a ride route row | Owner opens `/community/[id]`; a ride opens `/community/rides/[id]` (collections hold rides only — trips are private/collaborator-only) |
| T44c | Regional leaderboard links | On `/achievements`, click a rider row in "Regional leaderboards"                       | Opens that rider's `/community/[id]` profile; avatars match the community feed's initials avatar                                        |

## WEB-EPIC 5: Account & Settings (P1)

| #   | Scenario           | Steps                                                 | Expected Result                                |
| --- | ------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| T45 | Register           | Navigate to `/register`, fill form                    | Account created, redirected to dashboard       |
| T46 | Login              | Navigate to `/login`, enter credentials               | JWT set, redirected to dashboard               |
| T47 | Social login       | Click Google/Apple OAuth button                       | OAuth flow completes, account linked           |
| T48 | Forgot password    | Navigate to `/forgot-password`, enter email           | Reset email sent confirmation                  |
| T49 | Auth persistence   | Login, close tab, reopen `/trips`                     | Session restored, no re-login                  |
| T50 | Profile edit       | Navigate to `/settings`, change display name          | Name updates, reflected in topbar              |
| T51 | Bike management    | Navigate to `/settings/bikes`, add bike               | Bike saved, appears in list                    |
| T52 | Set active bike    | Select bike as active                                 | Active indicator shown                         |
| T53 | Delete bike        | Remove bike from list                                 | Bike removed, confirmation shown               |
| T54 | Privacy settings   | Navigate to `/settings/privacy`, toggle visibility    | Setting saved, public profile reflects         |
| T55 | Notification prefs | Navigate to `/settings/notifications`, toggle digests | Preferences saved                              |
| T56 | Data export        | Navigate to `/settings/data`, request export          | Downloads ZIP with rides, routes, profile      |
| T57 | Account deletion   | Navigate to `/settings/data`, confirm deletion        | Account removed, redirected to landing         |
| T58 | Subscription       | Navigate to `/settings/subscription`                  | Current tier, billing history, upgrade options |

## Cross-Cutting

| #   | Scenario                | Steps                                         | Expected Result                                          |
| --- | ----------------------- | --------------------------------------------- | -------------------------------------------------------- |
| T59 | Logo clickable          | Click logo in topbar                          | Navigates to dashboard/home                              |
| T60 | Logout                  | Click logout button in user menu              | Session cleared, redirected to login                     |
| T61 | User menu dropdown      | Click username/avatar in topbar               | Dropdown with Settings, Logout options                   |
| T62 | Notification bell       | Click bell icon in topbar                     | Shows recent notifications or marks as read              |
| T63 | Active nav highlighting | Navigate to sub-routes (e.g. /settings/bikes) | Only the active parent item is highlighted, not siblings |
| T64 | Responsive layout       | Resize 1920px > 390px                         | Sidebar collapses, map reflows, nav adapts               |
| T65 | Mobile browser          | Open on phone Safari/Chrome                   | Touch-friendly, no horizontal overflow                   |
| T66 | Offline indicator       | Disconnect network                            | Indicator appears, map shows cached tiles                |
| T67 | Reconnect               | Reconnect network                             | Data refreshes, indicator dismisses                      |
| T68 | Deep link auth          | Paste `/trips/[id]` URL logged-out            | Redirected to login, then back to trip after auth        |
| T69 | 404 page                | Navigate to `/nonexistent`                    | Custom 404 with navigation back                          |
| T70 | SEO metadata            | View source on `/roads/best/CZ`               | Structured data, meta description, og:image              |

## Priority

1. **P0 — Must pass:** T1-T8, T15-T24, T45-T49 (planner, explorer, auth)
2. **P1 — Should pass:** T9-T14, T29-T36, T50-T58 (trip mgmt, rides, settings)
3. **P2 — Nice to pass:** T23-T28, T37-T44, T59-T70 (SEO, community, cross-cutting)
