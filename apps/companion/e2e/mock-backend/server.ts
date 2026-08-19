import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { buildFeatureSnapshot, buildLimitSnapshot } from "@tarmoto/shared";
import { state, type MockSession } from "./state";

interface AuthedRequest extends Request {
  session?: MockSession;
}

const MOCK_FUN_ZONE_ID = "11111111-2222-4333-8444-555555555000";
const MOCK_ROAD_SEGMENT_ID = "11111111-2222-4333-8444-555555555111";

// Mirrors `BADGE_DEFINITIONS` in
// `apps/backend/src/modules/badges/badge-definitions.ts`. Production
// `BadgesService.listBadges` always returns this 7-entry catalogue
// with `tier`/`earned_at` set to null for badges the rider hasn't
// earned yet. The mock doesn't compute progress (no real
// rides/hazards/reviews aggregation), so `current: 0` is the right
// default — it lets the profile page render the catalogue with the
// "No badges earned yet" state instead of the empty-catalogue state.
// Keep this list in sync if a badge is added/removed upstream.
const MOCK_BADGE_CATALOGUE = [
  {
    key: "total_distance",
    category: "distance",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 100, silver: 1000, gold: 10000 },
  },
  {
    key: "single_ride",
    category: "distance",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 50, silver: 200, gold: 500 },
  },
  {
    key: "ride_count",
    category: "distance",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 10, silver: 50, gold: 200 },
  },
  {
    key: "roads_discovered",
    category: "exploration",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 25, silver: 100, gold: 500 },
  },
  {
    key: "reviews_written",
    category: "exploration",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 5, silver: 25, gold: 100 },
  },
  {
    key: "hazards_reported",
    category: "community",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 5, silver: 25, gold: 100 },
  },
  {
    key: "rides_shared",
    category: "community",
    tier: null,
    earned_at: null,
    progress: { current: 0, bronze: 3, silver: 15, gold: 50 },
  },
] as const;

// `@types/express-serve-static-core` 5.x types `req.params[key]` as
// `string | string[]` because Express 5 supports repeated-segment route
// params. The mock never uses those patterns, so tunnel each access
// through this helper to get a plain string back.
function param(req: Request, key: string): string {
  const v = req.params[key];
  if (Array.isArray(v)) return v[0] ?? "";
  return typeof v === "string" ? v : "";
}

function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const session = state.resolveSession(req.header("authorization"));
  if (!session) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  req.session = session;
  next();
}

function tokenResponse(session: MockSession) {
  const user = state.users.get(session.user_id);
  if (!user) throw new Error("user-not-found");
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: 60 * 60,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      phone: user.phone,
    },
  };
}

function mockFunZone() {
  return {
    id: MOCK_FUN_ZONE_ID,
    name: "Mock Ridge Fun Zone",
    composite_score: 4.6,
    road_count: 12,
    total_curve_km: 48,
    avg_quality: 4.2,
    best_season: "summer",
    boundary: [
      { lat: 46.45, lng: 10.3 },
      { lat: 46.45, lng: 10.6 },
      { lat: 46.7, lng: 10.6 },
      { lat: 46.7, lng: 10.3 },
      { lat: 46.45, lng: 10.3 },
    ],
  };
}

function mockRoadSegmentDetail() {
  const reviews = state.roadReviews.get(MOCK_ROAD_SEGMENT_ID) ?? [];
  const avg =
    reviews.length === 0
      ? 4.5
      : Math.round(
          (reviews.reduce((sum, review) => sum + review.rating, 0) /
            reviews.length) *
            10,
        ) / 10;
  return {
    id: MOCK_ROAD_SEGMENT_ID,
    road_name: "Mock Ridge Road",
    road_number: "MR-12",
    quality_score: 4.6,
    curviness_score: 82,
    surface_type: "asphalt",
    length_m: 1240,
    confidence: 91,
    reading_count: 37,
    last_updated: "2026-05-10T12:00:00.000Z",
    geometry: [
      { lat: 46.45, lng: 10.3 },
      { lat: 46.58, lng: 10.48 },
    ],
    elevation_min: 840,
    elevation_max: 1260,
    elevation_profile: [840, 1020, 1260],
    quality_breakdown: {
      excellent: 60,
      good: 30,
      fair: 10,
      poor: 0,
      very_poor: 0,
    },
    active_hazards: [
      {
        id: "haz-1",
        hazard_type: "gravel",
        severity: "medium",
        note: "Loose gravel after the bend",
        photo_url: null,
        confirmations: 3,
        reporter: "Jane Rider",
        road_name: "Mock Ridge Road",
        lat: 46.5,
        lng: 10.4,
        created_at: "2026-05-10T10:00:00.000Z",
        expires_at: "2026-05-13T10:00:00.000Z",
      },
    ],
    active_hazard_count: 1,
    recent_reviews: reviews.slice(0, 5).map(serializeRoadReview),
    review_count: reviews.length || 1,
    avg_review_rating: avg,
    riders_per_month: 12,
    quality_history: [
      { month: "2026-03", score: 4.1 },
      { month: "2026-04", score: 4.6 },
    ],
    regional_quality_history: [{ month: "2026-04", score: 3.8 }],
  };
}

function seedRoadReviews() {
  if (state.roadReviews.has(MOCK_ROAD_SEGMENT_ID)) return;
  state.roadReviews.set(MOCK_ROAD_SEGMENT_ID, [
    {
      id: "review-seeded-1",
      segment_id: MOCK_ROAD_SEGMENT_ID,
      user_id: null,
      user_display_name: "Ari Explorer",
      rating: 5,
      comment: "Fast surface with clean sight lines.",
      bike_model: "Yamaha Tracer",
      photos: ["http://127.0.0.1:4311/uploads/mock-review.jpg"],
      created_at: "2026-05-10T09:00:00.000Z",
      helpful_count: 2,
      not_helpful_count: 0,
    },
  ]);
}

function serializeRoadReview(review: {
  id: string;
  user_id: string | null;
  user_display_name: string;
  rating: number;
  comment: string | null;
  bike_model: string | null;
  photos: string[] | null;
  created_at: string;
  helpful_count: number;
  not_helpful_count: number;
}) {
  return {
    id: review.id,
    user_id: review.user_id,
    user_display_name: review.user_display_name,
    rating: review.rating,
    comment: review.comment,
    bike_model: review.bike_model,
    photos: review.photos,
    created_at: review.created_at,
    helpful_count: review.helpful_count,
    not_helpful_count: review.not_helpful_count,
    my_vote: null,
    is_mine: false,
  };
}

function describeSubscription(userId: string) {
  const sub = state.subscriptions.get(userId) ?? {
    tier: "free" as const,
    status: "active" as const,
    current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    cancel_at_period_end: false,
  };
  // The companion's `normalizeSubscriptionSnapshot` expects snake_case
  // keys per the OpenAPI contract; returning the camelCase shape here
  // would be silently treated as a "preview" fallback (portal disabled,
  // checkout button disabled), which would break the upgrade tests.
  return {
    current_plan: {
      tier: sub.tier,
      status: sub.status,
      renews_at: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end,
      manage_url: null,
    },
    plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
    payment_method:
      sub.tier === "free"
        ? null
        : { brand: "Visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    billing_history: [],
    // True for paid plans so the "Open billing portal" / "Update
    // payment method" buttons are clickable and the upgrade flow is
    // testable.
    portal_available: sub.tier !== "free",
  };
}

export function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Permissive CORS — the mock is for tests only, never exposed publicly.
  // The companion dev server at :4310 makes browser fetches to this mock
  // at :4311; without these headers preflight OPTIONS would fail.
  app.use((req, res, next) => {
    // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-Requested-With",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/__test__/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Reset all in-memory state between worker runs / individual tests.
  app.post("/__test__/reset", (_req, res) => {
    state.reset();
    res.json({ ok: true });
  });

  // Direct seeding hook used by Playwright fixtures so tests can skip
  // walking through the registration UI when they only need an
  // authenticated context.
  app.post("/__test__/seed-user", (req, res) => {
    const { email, password, display_name } = req.body ?? {};
    if (!email || !password || !display_name) {
      res.status(400).json({ message: "missing-fields" });
      return;
    }
    if (state.findUserByEmail(email)) {
      res.status(409).json({ message: "email-taken" });
      return;
    }
    const user = state.createUser({ email, password, display_name });
    const session = state.createSession(user.id);
    res.json(tokenResponse(session));
  });

  // Membership shortcut: tests that drive collaboration UI need both
  // users in `trip.members` so the trip detail / planner pages don't
  // 404. Going through a real invite flow is out of scope for E2E.
  app.post("/__test__/add-trip-member", (req, res) => {
    const { trip_id, user_id } = req.body ?? {};
    const trip = state.trips.get(String(trip_id));
    if (!trip) {
      res.status(404).json({ message: "trip-not-found" });
      return;
    }
    if (!trip.members.includes(String(user_id))) {
      trip.members.push(String(user_id));
    }
    res.json({ ok: true });
  });

  // Seed a follow edge (follower → following) so tests can exercise
  // relationship-dependent UI (e.g. the "Follows you" badge) without
  // driving the follow flow from a second authenticated session.
  app.post("/__test__/seed-follow", (req, res) => {
    const { follower_id, following_id } = req.body ?? {};
    if (!follower_id || !following_id) {
      res.status(400).json({ message: "missing-fields" });
      return;
    }
    let following = state.userFollows.get(String(follower_id));
    if (!following) {
      following = new Map<string, string>();
      state.userFollows.set(String(follower_id), following);
    }
    following.set(String(following_id), new Date().toISOString());
    res.json({ ok: true });
  });

  // Allow tests to switch a user's subscription state without driving
  // a full Stripe checkout — Stripe is mocked and never actually called.
  app.post("/__test__/set-subscription", (req, res) => {
    const { user_id, tier } = req.body ?? {};
    if (!user_id || !tier) {
      res.status(400).json({ message: "missing-fields" });
      return;
    }
    const existing = state.subscriptions.get(user_id);
    if (!existing) {
      res.status(404).json({ message: "user-not-found" });
      return;
    }
    state.subscriptions.set(user_id, { ...existing, tier });
    res.json({ ok: true });
  });

  app.post("/__test__/seed-ride", (req, res) => {
    const { user_id, ride } = req.body ?? {};
    if (!user_id || !ride) {
      res.status(400).json({ message: "missing-fields" });
      return;
    }
    const id = ride.id ?? randomUUID();
    const startedAt = ride.started_at ?? new Date().toISOString();
    // Production derives `duration_min` from `ended_at - started_at`,
    // so the source of truth is the timestamps. The seed API still
    // accepts `duration_min` as an ergonomic hint — use it to fix
    // `ended_at` when callers didn't supply one — but the row no
    // longer carries a separate stored duration that could drift.
    const endedAt: string =
      ride.ended_at ??
      new Date(
        new Date(startedAt).getTime() +
          Number(ride.duration_min ?? 60) * 60 * 1000,
      ).toISOString();
    const seeded: import("./state").MockRide = {
      id,
      user_id,
      name: ride.name ?? null,
      ride_type: ride.ride_type ?? "leisure",
      status: ride.status ?? "completed",
      started_at: startedAt,
      ended_at: endedAt,
      distance_km: Number(ride.distance_km ?? 100),
      avg_speed: Number(ride.avg_speed ?? 80),
      max_speed: Number(ride.max_speed ?? 130),
      avg_road_quality: Number(ride.avg_road_quality ?? 4),
      // `avg_curviness` is explicitly nullable on the wire — production
      // returns null when no scored segments were crossed. Default to a
      // mid-range value (3) so seeded rides exercise the populated
      // branch; tests that want the null branch can pass `avg_curviness:
      // null` explicitly.
      avg_curviness:
        ride.avg_curviness === null ? null : Number(ride.avg_curviness ?? 3),
      elevation_gain: Number(ride.elevation_gain ?? 500),
      elevation_loss: Number(ride.elevation_loss ?? 500),
      curve_count: Number(ride.curve_count ?? 80),
      max_lean_angle: Number(ride.max_lean_angle ?? 35),
      fuel_estimate_l: Number(ride.fuel_estimate_l ?? 5),
      route_geometry: Array.isArray(ride.route_geometry)
        ? ride.route_geometry
        : [
            { lat: 46.47, lng: 10.37 },
            { lat: 46.55, lng: 10.45 },
          ],
      segments: Array.isArray(ride.segments)
        ? ride.segments.map(
            (s: {
              road_name?: string | null;
              quality_reading?: number | null;
              speed_avg?: number | null;
              speed_max?: number | null;
              lean_angle_max?: number | null;
            }) => ({
              road_name: s.road_name ?? null,
              quality_reading: s.quality_reading ?? null,
              speed_avg: s.speed_avg ?? null,
              speed_max: s.speed_max ?? null,
              lean_angle_max: s.lean_angle_max ?? null,
            }),
          )
        : [],
    };
    state.rides.set(id, seeded);
    res.status(201).json({ id });
  });

  // Stand up a route collection so `/community/collections/*` flows
  // have something to render. Caller controls visibility + slug so a
  // shared-by-slug e2e can hit a deterministic URL.
  app.post("/__test__/seed-collection", (req, res) => {
    const { owner_id, collection } = req.body ?? {};
    if (!owner_id || !state.users.has(owner_id)) {
      res.status(400).json({ message: "owner-not-found" });
      return;
    }
    const c = collection ?? {};
    const id = c.id ?? randomUUID();
    const slug = String(c.slug ?? `collection-${id.slice(0, 8)}`);
    const now = new Date().toISOString();
    const seeded: import("./state").MockCollection = {
      id,
      owner_id,
      title: String(c.title ?? "Untitled collection"),
      description: c.description ?? null,
      visibility: c.visibility ?? "private",
      slug,
      created_at: c.created_at ?? now,
      updated_at: c.updated_at ?? now,
    };
    state.collections.set(id, seeded);
    state.collectionsBySlug.set(slug, id);
    res.status(201).json({ id, slug });
  });

  // Stand up a public-share record so an anonymous visit to
  // `/rides/shared/:token` can resolve to a seeded ride. Token
  // defaults to a generated one; `is_public` defaults to true so the
  // share also flows through the public `/rides/community` feed —
  // tests that need a private/unlisted share can pass `is_public:
  // false`.
  app.post("/__test__/seed-ride-share", (req, res) => {
    const { ride_id, token, is_public } = req.body ?? {};
    if (!ride_id || !state.rides.has(ride_id)) {
      res.status(400).json({ message: "ride-not-found" });
      return;
    }
    const finalToken = String(token ?? randomUUID());
    state.rideShares.set(finalToken, {
      ride_id,
      is_public: is_public !== false,
      view_count: 0,
    });
    res.status(201).json({ token: finalToken });
  });

  // Stand up a road closure that the planner's closures panel will
  // surface once a trip route is generated. Tests seed one closure
  // conceptually-over the demo trip route and assert on the rendered
  // counter copy — the mock's `check-route` endpoint reports any
  // seeded closure as crossing the supplied route, so geometry
  // fidelity isn't required here.
  app.post("/__test__/seed-closure", (req, res) => {
    const c = req.body?.closure ?? {};
    const id = c.id ?? randomUUID();
    const now = new Date().toISOString();
    const closure: import("./state").MockRoadClosure = {
      id,
      title: String(c.title ?? "Roadworks on the demo route"),
      reason: c.reason ?? "roadworks",
      severity: c.severity ?? "full",
      // Default geometry overlaps the demo-trip's generated start
      // point (46.47, 10.37) so the production-like proximity
      // filter on `/closures/check-route` actually matches with
      // the default 100m buffer.
      geometry: c.geometry ?? [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.48, lng: 10.39 },
      ],
      detour: c.detour ?? null,
      country_code: c.country_code ?? "IT",
      region: c.region ?? "Lombardia",
      // Default to a stable past start so the closure passes the
      // `active_on` filter regardless of which calendar day the
      // suite runs on. The planner's `useClosures` derives
      // `active_on` from the user's `travelMonth` (15th of that
      // month); seeding `now()` would let a closure sit in the
      // future on the 15th of any month and disappear from the
      // production-correct filter.
      starts_at: c.starts_at ?? "2020-01-01T00:00:00.000Z",
      ends_at: c.ends_at ?? null,
      notes: c.notes ?? null,
      source: c.source ?? "operator",
      created_by: c.created_by ?? null,
      created_at: c.created_at ?? now,
      updated_at: c.updated_at ?? now,
    };
    state.closures.set(id, closure);
    res.status(201).json({ id });
  });

  // Seed a full trip (with optional route geometry on day 1, or multiple
  // days via the `days` array) so e2e tests can open a trip via `?tripId=`
  // without driving the context-menu flow. The route snapshot is stored in
  // `trip.snapshot.days` exactly as the `/generate` endpoint does, so
  // `serializeTripDetail` → `tripFromDetail` picks it up immediately. The
  // auth token is required (mirrors the real POST /trips gate) so the
  // seeded trip is owned by a real user.
  //
  // Two calling conventions:
  //   • Single-day (legacy): `{ route_geometry, waypoints, distance_km? }`
  //   • Multi-day (new): `{ days: [{ route_geometry, waypoints,
  //     start_linked?, distance_km? }] }`
  app.post("/__test__/seed-trip", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const body = req.body ?? {};
    const id = String(body.id ?? randomUUID());
    const now = new Date().toISOString();

    // Helper: serialize a raw waypoint array into TripDetailWaypoint shape.
    function serializeWaypoints(
      rawWps: Array<{
        lat: number;
        lng: number;
        name?: string | null;
        type?: string;
      }>,
      tripId: string,
      dayIndex: number,
    ) {
      return rawWps.map((wp, i) => ({
        id: `seeded-wp-${tripId}-d${dayIndex + 1}-${i}`,
        sequence: i,
        lat: Number(wp.lat),
        lng: Number(wp.lng),
        name: wp.name ?? null,
        waypoint_type: wp.type ?? (i === 0 ? "start" : "end"),
        road_segment_id: null,
        notes: null,
        duration_min: null,
      }));
    }

    let snapshotDays: unknown[] = [];

    if (Array.isArray(body.days)) {
      // ── Multi-day path ──────────────────────────────────────────────
      type RawDay = {
        route_geometry?: Array<{ lat: number; lng: number }>;
        waypoints?: Array<{
          lat: number;
          lng: number;
          name?: string | null;
          type?: string;
        }>;
        start_linked?: boolean;
        distance_km?: number;
      };
      const rawDays = body.days as RawDay[];
      snapshotDays = rawDays.map((d, di) => {
        const geo: Array<{ lat: number; lng: number }> = Array.isArray(
          d.route_geometry,
        )
          ? d.route_geometry
          : [];
        const wps = Array.isArray(d.waypoints) ? d.waypoints : [];
        const distanceKm = Number(d.distance_km ?? 125);
        return {
          id: `seeded-day-${id}-${di + 1}`,
          day_number: di + 1,
          title: `Day ${di + 1}`,
          start_linked: d.start_linked ?? false,
          distance_km: distanceKm,
          avg_quality: 4.2,
          elevation_gain: Math.round(distanceKm * 6),
          elevation_loss: Math.round(distanceKm * 4),
          curviness_score: 74,
          scenic_score: 80,
          estimated_time_min: Math.round(distanceKm * 1.2),
          route_geometry: geo,
          waypoints: serializeWaypoints(wps, id, di),
        };
      });
    } else {
      // ── Single-day path (legacy) ────────────────────────────────────
      const routeGeometry: Array<{ lat: number; lng: number }> = Array.isArray(
        body.route_geometry,
      )
        ? body.route_geometry
        : [];
      const rawWaypoints: Array<{
        lat: number;
        lng: number;
        name?: string | null;
        type?: string;
      }> = Array.isArray(body.waypoints) ? body.waypoints : [];
      const hasRoute = routeGeometry.length >= 2;
      const distanceKm = hasRoute ? Number(body.distance_km ?? 125) : 0;
      if (hasRoute) {
        snapshotDays = [
          {
            id: `seeded-day-${id}-1`,
            day_number: 1,
            title: "Day 1",
            start_linked: false,
            distance_km: distanceKm,
            avg_quality: 4.2,
            elevation_gain: Math.round(distanceKm * 6),
            elevation_loss: Math.round(distanceKm * 4),
            curviness_score: 74,
            scenic_score: 80,
            estimated_time_min: Math.round(distanceKm * 1.2),
            route_geometry: routeGeometry,
            waypoints: serializeWaypoints(rawWaypoints, id, 0),
          },
        ];
      }
    }

    const numDays = snapshotDays.length > 0 ? snapshotDays.length : 1;
    const trip: import("./state").MockTrip = {
      id,
      owner_id: session.user_id,
      title: String(body.title ?? "Seeded trip"),
      num_days: numDays,
      daily_km_min: 100,
      daily_km_max: 300,
      min_quality: 3,
      road_preference: "mixed",
      status: "planned" as const,
      members: [session.user_id],
      snapshot: snapshotDays.length > 0 ? { days: snapshotDays } : {},
      created_at: now,
      updated_at: now,
    };
    state.trips.set(id, trip);
    pushActivity(id, session.user_id, "trip_updated", {});
    res.status(201).json(serializeTripDetail(trip));
  });

  // ── Auth ──────────────────────────────────────────────────────────
  app.post("/api/v1/auth/register", (req, res) => {
    const { email, password, display_name } = req.body ?? {};
    if (!email || !password || !display_name) {
      res.status(400).json({ message: "missing-fields" });
      return;
    }
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ message: "weak-password" });
      return;
    }
    if (state.findUserByEmail(email)) {
      res
        .status(409)
        .json({ message: "An account with that email already exists" });
      return;
    }
    const user = state.createUser({ email, password, display_name });
    const session = state.createSession(user.id);
    res.status(201).json(tokenResponse(session));
  });

  app.post("/api/v1/auth/login", (req, res) => {
    const { email, password } = req.body ?? {};
    const user = state.findUserByEmail(String(email ?? ""));
    if (!user || user.password !== password) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }
    const session = state.createSession(user.id);
    res.json(tokenResponse(session));
  });

  app.post("/api/v1/auth/refresh", (req, res) => {
    const { refresh_token } = req.body ?? {};
    const next = state.rotateSession(String(refresh_token ?? ""));
    if (!next) {
      res.status(401).json({ message: "invalid-refresh" });
      return;
    }
    res.json(tokenResponse(next));
  });

  app.post("/api/v1/auth/forgot-password", (req, res) => {
    res.status(204).end();
    void req;
  });

  // ── Roads / Best ─────────────────────────────────────────────────
  // Best Roads SSR pages (`/roads/best/:country/:region`) and the embed
  // widget (`/embed/roads/:country/:region`) both fetch this endpoint at
  // request time. The mock returns a stable two-road region so the e2e
  // suite can assert the curated list rendered + SEO metadata wired up.
  app.get("/api/v1/roads/best", (req, res) => {
    const country = String(req.query.country ?? "").toLowerCase();
    const region = String(req.query.region ?? "").toLowerCase();
    if (!country || !region) {
      res.status(400).json({ message: "missing-region" });
      return;
    }
    res.json({
      region: {
        slug: region,
        country,
        name: region.replace(/-/g, " "),
        bbox: [18, 49.3, 18.85, 49.7],
      },
      roads: [
        {
          id: "22222222-3333-4444-8555-666666666111",
          road_name: "Mock Ridge Road",
          road_number: "32",
          quality_score: 4.5,
          curviness_score: 3.6,
          surface_type: "asphalt",
          length_m: 12_400,
          confidence: 92,
          geometry: [
            { lat: 49.55, lng: 18.3 },
            { lat: 49.56, lng: 18.32 },
          ],
          best_score: 91,
        },
        {
          id: "22222222-3333-4444-8555-666666666222",
          road_name: "Sunset Climb",
          road_number: null,
          quality_score: 4.2,
          curviness_score: 4.1,
          surface_type: "asphalt",
          length_m: 8_900,
          confidence: 85,
          geometry: [
            { lat: 49.61, lng: 18.41 },
            { lat: 49.63, lng: 18.45 },
          ],
          best_score: 88,
        },
      ],
    });
  });

  // ── Roads / Fun Zones ────────────────────────────────────────────
  app.get("/api/v1/roads/fun-zones", (req, res) => {
    const bbox = String(req.query.bbox ?? "")
      .split(",")
      .map(Number);
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
      res.status(400).json({ message: "invalid-bbox" });
      return;
    }
    res.json([mockFunZone()]);
  });

  app.get("/api/v1/roads/fun-zones/:id", (req, res) => {
    if (param(req, "id") !== MOCK_FUN_ZONE_ID) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    res.json({
      zone: mockFunZone(),
      top_roads: [
        {
          id: "11111111-2222-4333-8444-555555555111",
          road_name: "Mock Ridge Road",
          road_number: "MR-12",
          quality_score: 4.7,
          curviness_score: 4.5,
          surface_type: "asphalt",
          length_m: 12340,
          confidence: 92,
          elevation_min: 840,
          elevation_max: 1620,
          elevation_profile: null,
          geometry: [
            { lat: 46.45, lng: 10.3 },
            { lat: 46.58, lng: 10.48 },
          ],
          contribution_score: 9.1,
        },
      ],
    });
  });

  app.get("/api/v1/roads/:segmentId/reviews", (req: AuthedRequest, res) => {
    const segmentId = param(req, "segmentId");
    if (segmentId !== MOCK_ROAD_SEGMENT_ID) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    seedRoadReviews();
    const session = state.resolveSession(req.header("authorization"));
    const reviews = state.roadReviews.get(segmentId) ?? [];
    res.json(
      reviews.map((review) => ({
        ...serializeRoadReview(review),
        is_mine: session?.user_id === review.user_id,
      })),
    );
  });

  app.post(
    "/api/v1/roads/:segmentId/reviews",
    requireAuth,
    (req: AuthedRequest, res) => {
      const segmentId = param(req, "segmentId");
      if (segmentId !== MOCK_ROAD_SEGMENT_ID) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const session = req.session!;
      const user = state.users.get(session.user_id);
      if (!user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      seedRoadReviews();
      const reviews = state.roadReviews.get(segmentId) ?? [];
      const existing = reviews.find((review) => review.user_id === user.id);
      if (existing) {
        res
          .status(409)
          .json({ message: "You have already reviewed this road" });
        return;
      }
      const review = {
        id: randomUUID(),
        segment_id: segmentId,
        user_id: user.id,
        user_display_name: user.display_name,
        rating: Number(req.body?.rating ?? 0),
        comment: req.body?.comment ? String(req.body.comment) : null,
        bike_model: req.body?.bike_model ? String(req.body.bike_model) : null,
        photos: Array.isArray(req.body?.photos) ? req.body.photos : [],
        created_at: new Date().toISOString(),
        helpful_count: 0,
        not_helpful_count: 0,
      };
      reviews.unshift(review);
      state.roadReviews.set(segmentId, reviews);
      res.status(201).json({
        ...serializeRoadReview(review),
        is_mine: true,
      });
    },
  );

  app.get("/api/v1/roads/:segmentId", (req, res) => {
    if (param(req, "segmentId") !== MOCK_ROAD_SEGMENT_ID) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    seedRoadReviews();
    res.json(mockRoadSegmentDetail());
  });

  // ── Trips ─────────────────────────────────────────────────────────
  app.get("/api/v1/trips", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const items = [...state.trips.values()]
      .filter(
        (t) =>
          t.owner_id === session.user_id || t.members.includes(session.user_id),
      )
      .map((t) => serializeTripCard(t));
    // The companion's `/trips` page accepts either a bare array or
    // `{data: [...]}`; we hand back an array since the underlying type
    // (local `Trip` shape) matches what `apiFetch<T>()` already
    // type-asserts in the list page.
    res.json(items);
  });

  app.post("/api/v1/trips", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const { title, num_days } = req.body ?? {};
    const id = randomUUID();
    const now = new Date().toISOString();
    const trip = {
      id,
      owner_id: session.user_id,
      title: String(title ?? "Untitled trip"),
      num_days: Number(num_days ?? 1),
      daily_km_min: Number(req.body?.daily_km_min ?? 200),
      daily_km_max: Number(req.body?.daily_km_max ?? 300),
      min_quality: Number(req.body?.min_quality ?? 3),
      road_preference: String(req.body?.road_preference ?? "mixed"),
      status: "draft" as const,
      members: [session.user_id],
      snapshot: {},
      created_at: now,
      updated_at: now,
    };
    state.trips.set(id, trip);
    pushActivity(id, session.user_id, "trip_updated", {});
    res.status(201).json(serializeTripDetail(trip));
  });

  app.get("/api/v1/trips/:id", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const trip = state.trips.get(param(req, "id"));
    if (
      !trip ||
      (trip.owner_id !== session.user_id &&
        !trip.members.includes(session.user_id))
    ) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    res.json(serializeTripDetail(trip));
  });

  app.patch("/api/v1/trips/:id", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const trip = state.trips.get(param(req, "id"));
    if (!trip || trip.owner_id !== session.user_id) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    const updated = {
      ...trip,
      title: req.body?.title ?? trip.title,
      num_days: req.body?.num_days ?? trip.num_days,
      daily_km_min: req.body?.daily_km_min ?? trip.daily_km_min,
      daily_km_max: req.body?.daily_km_max ?? trip.daily_km_max,
      min_quality: req.body?.min_quality ?? trip.min_quality,
      road_preference: req.body?.road_preference ?? trip.road_preference,
      status: req.body?.status ?? trip.status,
      snapshot: req.body?.snapshot ?? trip.snapshot,
      updated_at: new Date().toISOString(),
    };
    state.trips.set(updated.id, updated);
    pushActivity(updated.id, session.user_id, "trip_updated", {});
    res.json(serializeTripDetail(updated));
  });

  app.delete("/api/v1/trips/:id", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const trip = state.trips.get(param(req, "id"));
    if (!trip || trip.owner_id !== session.user_id) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    state.trips.delete(param(req, "id"));
    res.status(204).end();
  });

  // US-37: duplicate retains the title with a "(copy)" suffix and assigns
  // the caller as the new owner. Returns a TripDetailDto per the OpenAPI
  // contract; the companion must adapt this through `tripFromDetail`
  // before rendering — the mock will NOT carry a companion-friendly
  // camelCase `name` so any callsite that forgets the adapter fails the
  // same way it would in production.
  app.post(
    "/api/v1/trips/:id/duplicate",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const source = state.trips.get(param(req, "id"));
      if (
        !source ||
        (source.owner_id !== session.user_id &&
          !source.members.includes(session.user_id))
      ) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const newId = randomUUID();
      const now = new Date().toISOString();
      // Folders are per-user on the backend (`TripsService.duplicate`
      // preserves `folder_id` only when the caller is the source's
      // owner — a collaborator who duplicates someone else's filed
      // trip gets an unfiled copy because the source folder belongs to
      // the original owner). Mirror that here so an e2e exercising
      // collaborator-side duplicate doesn't get a "filed into someone
      // else's folder" copy that production would never produce.
      const callerIsSourceOwner = source.owner_id === session.user_id;
      const copy: import("./state").MockTrip = {
        ...source,
        id: newId,
        owner_id: session.user_id,
        title: `${source.title} (copy)`,
        status: "draft",
        members: [session.user_id],
        snapshot: { ...source.snapshot },
        folder_id: callerIsSourceOwner ? source.folder_id : null,
        created_at: now,
        updated_at: now,
      };
      state.trips.set(newId, copy);
      pushActivity(newId, session.user_id, "trip_updated", {});
      res.status(201).json(serializeTripDetail(copy));
    },
  );

  app.post(
    "/api/v1/trips/:id/generate",
    requireAuth,
    (req: AuthedRequest, res) => {
      const trip = state.trips.get(param(req, "id"));
      if (!trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const selected = String(req.body?.option ?? "best-fit");
      const dailyTarget = Math.round(
        ((trip.daily_km_min ?? 250) + (trip.daily_km_max ?? 250)) / 2,
      );
      const options = ["best-fit", "scenic", "fastest"].map((id) =>
        buildGeneratedOption(
          id,
          selected,
          trip.num_days,
          dailyTarget,
          req.body,
        ),
      );
      const selectedOption = options.find((option) => option.id === selected)!;
      const updated = {
        ...trip,
        status: "planned" as const,
        snapshot: {
          ...trip.snapshot,
          days: selectedOption.days,
          selected_option: selected,
          generation_request: req.body ?? {},
        },
        updated_at: new Date().toISOString(),
      };
      state.trips.set(updated.id, updated);
      pushActivity(trip.id, req.session!.user_id, "trip_generated", {
        option: selected,
      });
      res.json({
        trip: serializeTripDetail(updated),
        selected_option: selected,
        options,
      });
    },
  );

  // ── Routing ───────────────────────────────────────────────────────
  // POST /routing/route — live road-snapped preview. The planner's
  // `usePlannerRouting` hook calls this on every waypoint edit with ≥2
  // routing waypoints. The mock returns a deterministic geometry that
  // spans the submitted waypoints so the map can draw a polyline and the
  // "Save route" button can enable. Shape matches `RouteResponseDto`.
  app.post("/api/v1/routing/route", requireAuth, (req: AuthedRequest, res) => {
    const waypoints = (req.body?.waypoints ?? []) as Array<{
      lat: number;
      lng: number;
    }>;
    if (waypoints.length < 2) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "waypoints must have at least 2 points",
      });
      return;
    }
    // Build a simple interpolated geometry spanning all waypoints.
    const geometry: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      geometry.push(a);
      // Add two midpoints per leg so the polyline has shape.
      geometry.push({
        lat: a.lat + (b.lat - a.lat) * 0.33,
        lng: a.lng + (b.lng - a.lng) * 0.33,
      });
      geometry.push({
        lat: a.lat + (b.lat - a.lat) * 0.67,
        lng: a.lng + (b.lng - a.lng) * 0.67,
      });
    }
    geometry.push(waypoints[waypoints.length - 1]!);
    // Rough distance: equirectangular approximation.
    let distanceKm = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      const dlat = (b.lat - a.lat) * 111;
      const dlng =
        (b.lng - a.lng) *
        111 *
        Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      distanceKm += Math.hypot(dlat, dlng);
    }
    distanceKm = Math.round(distanceKm * 10) / 10;
    res.status(201).json({
      geometry,
      distance_km: distanceKm,
      duration_min: Math.round(distanceKm * 1.2),
      avg_quality: 4.2,
      curviness_score: 74,
      elevation_gain_m: Math.round(distanceKm * 6),
      surface_mix: { asphalt: 1 },
    });
  });

  // PUT /trips/:tripId/route — saves the manual live-route to an existing
  // trip. Accepts two shapes:
  //   • NEW (multi-day, Phase 2): `{ days: [{ dayNumber, startLinked,
  //     waypoints }], options? }` — each entry is one persisted day.
  //   • OLD (single-day, Phase 1): `{ waypoints, options? }` — kept for
  //     backward compat so earlier trip-planner specs continue to pass.
  // In both cases the mock re-derives route geometry from the submitted
  // waypoints and returns a full TripDetailDto with per-day
  // `start_linked` and `route_geometry`. 404 for unknown trip or
  // non-member caller.
  app.put(
    "/api/v1/trips/:tripId/route",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const tripId = param(req, "tripId");
      const trip = state.trips.get(tripId);
      if (
        !trip ||
        (trip.owner_id !== session.user_id &&
          !trip.members.includes(session.user_id))
      ) {
        res.status(404).json({ message: "not-found" });
        return;
      }

      // Helper: build a route geometry polyline from a set of waypoints.
      function buildGeometry(
        wps: Array<{ lat: number; lng: number }>,
      ): Array<{ lat: number; lng: number }> {
        const geo: Array<{ lat: number; lng: number }> = [];
        for (let i = 0; i < wps.length - 1; i++) {
          const a = wps[i]!;
          const b = wps[i + 1]!;
          geo.push({ lat: a.lat, lng: a.lng });
          geo.push({
            lat: a.lat + (b.lat - a.lat) * 0.5,
            lng: a.lng + (b.lng - a.lng) * 0.5,
          });
        }
        geo.push({
          lat: wps[wps.length - 1]!.lat,
          lng: wps[wps.length - 1]!.lng,
        });
        return geo;
      }

      // Helper: approximate distance in km for a waypoint list.
      function approxDistanceKm(
        wps: Array<{ lat: number; lng: number }>,
      ): number {
        let d = 0;
        for (let i = 0; i < wps.length - 1; i++) {
          const a = wps[i]!;
          const b = wps[i + 1]!;
          const dlat = (b.lat - a.lat) * 111;
          const dlng =
            (b.lng - a.lng) *
            111 *
            Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
          d += Math.hypot(dlat, dlng);
        }
        return Math.round(d * 10) / 10;
      }

      // Detect new multi-day shape: body carries a `days` array.
      const daysInput = Array.isArray(req.body?.days) ? req.body.days : null;

      if (daysInput !== null) {
        // ── NEW multi-day path ────────────────────────────────────────
        type DayInput = {
          dayNumber: number;
          startLinked?: boolean;
          waypoints: Array<{
            lat: number;
            lng: number;
            name?: string | null;
            type?: string;
          }>;
        };
        const inputDays = daysInput as DayInput[];
        if (inputDays.length === 0) {
          res.status(400).json({
            statusCode: 400,
            error: "Bad Request",
            message: "days must have at least one entry",
          });
          return;
        }
        // Each day must have ≥2 waypoints (mirrors backend SaveRouteDayDto validation).
        for (let di = 0; di < inputDays.length; di++) {
          if ((inputDays[di]!.waypoints ?? []).length < 2) {
            res.status(400).json({
              statusCode: 400,
              error: "Bad Request",
              message: `days[${di}].waypoints must have at least 2 points`,
            });
            return;
          }
        }
        const savedDays = inputDays.map((d, di) => {
          const wps = d.waypoints;
          const geometry = buildGeometry(wps);
          const distanceKm = approxDistanceKm(wps);
          return {
            id: `route-day-${tripId}-${di + 1}`,
            day_number: di + 1,
            title: `Day ${di + 1}`,
            start_linked: d.startLinked ?? false,
            distance_km: distanceKm,
            avg_quality: 4.2,
            elevation_gain: Math.round(distanceKm * 6),
            elevation_loss: Math.round(distanceKm * 4),
            curviness_score: 74,
            scenic_score: 80,
            estimated_time_min: Math.round(distanceKm * 1.2),
            route_geometry: geometry,
            waypoints: wps.map((wp, i) => ({
              id: `route-wp-${tripId}-d${di + 1}-${i}`,
              sequence: i,
              lat: Number(wp.lat),
              lng: Number(wp.lng),
              name: wp.name ?? null,
              waypoint_type: wp.type ?? (i === 0 ? "start" : "end"),
              road_segment_id: null,
              notes: null,
              duration_min: null,
            })),
          };
        });
        const updated: import("./state").MockTrip = {
          ...trip,
          num_days: savedDays.length,
          status: "planned" as const,
          snapshot: { ...trip.snapshot, days: savedDays },
          updated_at: new Date().toISOString(),
        };
        state.trips.set(tripId, updated);
        pushActivity(tripId, session.user_id, "trip_updated", {});
        res.json(serializeTripDetail(updated));
        return;
      }

      // ── OLD single-day path (backward compat) ─────────────────────
      const waypoints = (req.body?.waypoints ?? []) as Array<{
        lat: number;
        lng: number;
        name?: string | null;
        type?: string;
      }>;
      if (waypoints.length < 2) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "waypoints must have at least 2 points",
        });
        return;
      }
      const geometry = buildGeometry(waypoints);
      const distanceKm = approxDistanceKm(waypoints);
      const day1 = {
        id: `route-day-${tripId}-1`,
        day_number: 1,
        title: "Day 1",
        start_linked: false,
        distance_km: distanceKm,
        avg_quality: 4.2,
        elevation_gain: Math.round(distanceKm * 6),
        elevation_loss: Math.round(distanceKm * 4),
        curviness_score: 74,
        scenic_score: 80,
        estimated_time_min: Math.round(distanceKm * 1.2),
        route_geometry: geometry,
        waypoints: waypoints.map((wp, i) => ({
          id: `route-wp-${tripId}-${i}`,
          sequence: i,
          lat: Number(wp.lat),
          lng: Number(wp.lng),
          name: wp.name ?? null,
          waypoint_type: wp.type ?? (i === 0 ? "start" : "end"),
          road_segment_id: null,
          notes: null,
          duration_min: null,
        })),
      };
      const updated: import("./state").MockTrip = {
        ...trip,
        num_days: 1,
        status: "planned" as const,
        snapshot: { ...trip.snapshot, days: [day1] },
        updated_at: new Date().toISOString(),
      };
      state.trips.set(tripId, updated);
      pushActivity(tripId, session.user_id, "trip_updated", {});
      res.json(serializeTripDetail(updated));
    },
  );

  // ── Trip suggestions ──────────────────────────────────────────────
  app.get(
    "/api/v1/trips/:id/suggestions",
    requireAuth,
    (req: AuthedRequest, res) => {
      const tripId = param(req, "id");
      const userId = req.session!.user_id;
      const items = [...state.suggestions.values()]
        .filter((s) => s.trip_id === tripId)
        .map((s) => serializeSuggestion(s, userId));
      res.json(items);
    },
  );

  app.post(
    "/api/v1/trips/:id/suggestions",
    requireAuth,
    (req: AuthedRequest, res) => {
      const tripId = param(req, "id");
      const userId = req.session!.user_id;
      const trip = state.trips.get(tripId);
      if (!trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const user = state.users.get(userId)!;
      const id = randomUUID();
      const now = new Date().toISOString();
      const suggestion = {
        id,
        trip_id: tripId,
        trip_day_id: req.body?.trip_day_id ?? null,
        suggested_by: userId,
        suggester_display_name: user.display_name,
        road_segment_id: req.body?.road_segment_id ?? null,
        title: String(req.body?.title ?? ""),
        description: req.body?.description ?? null,
        lat: req.body?.lat ?? null,
        lng: req.body?.lng ?? null,
        status: "open" as const,
        up_votes: 0,
        down_votes: 0,
        votes: {} as Record<string, "up" | "down">,
        created_at: now,
        updated_at: now,
      };
      state.suggestions.set(id, suggestion);
      pushActivity(tripId, userId, "suggestion_created", {
        title: suggestion.title,
      });
      res.status(201).json(serializeSuggestion(suggestion, userId));
    },
  );

  app.post(
    "/api/v1/trips/:tripId/suggestions/:suggestionId/vote",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const suggestion = state.suggestions.get(param(req, "suggestionId"));
      if (!suggestion || suggestion.trip_id !== param(req, "tripId")) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const vote = req.body?.vote;
      if (vote !== "up" && vote !== "down") {
        res.status(400).json({ message: "invalid-vote" });
        return;
      }
      const previous = suggestion.votes[userId];
      suggestion.votes[userId] = vote;
      if (previous === "up") suggestion.up_votes -= 1;
      if (previous === "down") suggestion.down_votes -= 1;
      if (vote === "up") suggestion.up_votes += 1;
      else suggestion.down_votes += 1;
      suggestion.updated_at = new Date().toISOString();
      pushActivity(suggestion.trip_id, userId, "suggestion_voted", { vote });
      res.json(serializeSuggestion(suggestion, userId));
    },
  );

  app.delete(
    "/api/v1/trips/:tripId/suggestions/:suggestionId/vote",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const suggestion = state.suggestions.get(param(req, "suggestionId"));
      if (!suggestion || suggestion.trip_id !== param(req, "tripId")) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const previous = suggestion.votes[userId];
      if (previous === "up") suggestion.up_votes -= 1;
      if (previous === "down") suggestion.down_votes -= 1;
      delete suggestion.votes[userId];
      suggestion.updated_at = new Date().toISOString();
      pushActivity(suggestion.trip_id, userId, "suggestion_vote_removed", {});
      res.json(serializeSuggestion(suggestion, userId));
    },
  );

  app.post(
    "/api/v1/trips/:tripId/suggestions/:suggestionId/accept",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const suggestion = state.suggestions.get(param(req, "suggestionId"));
      const trip = suggestion ? state.trips.get(suggestion.trip_id) : null;
      if (!suggestion || !trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (trip.owner_id !== userId) {
        res.status(403).json({ message: "owner-only" });
        return;
      }
      suggestion.status = "accepted";
      suggestion.updated_at = new Date().toISOString();
      pushActivity(trip.id, userId, "suggestion_accepted", {
        title: suggestion.title,
      });
      res.json(serializeSuggestion(suggestion, userId));
    },
  );

  app.post(
    "/api/v1/trips/:tripId/suggestions/:suggestionId/reject",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const suggestion = state.suggestions.get(param(req, "suggestionId"));
      const trip = suggestion ? state.trips.get(suggestion.trip_id) : null;
      if (!suggestion || !trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (trip.owner_id !== userId) {
        res.status(403).json({ message: "owner-only" });
        return;
      }
      suggestion.status = "rejected";
      suggestion.updated_at = new Date().toISOString();
      pushActivity(trip.id, userId, "suggestion_rejected", {
        title: suggestion.title,
      });
      res.json(serializeSuggestion(suggestion, userId));
    },
  );

  app.delete(
    "/api/v1/trips/:tripId/suggestions/:suggestionId",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const suggestion = state.suggestions.get(param(req, "suggestionId"));
      const trip = suggestion ? state.trips.get(suggestion.trip_id) : null;
      if (!suggestion || !trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (suggestion.suggested_by !== userId && trip.owner_id !== userId) {
        res.status(403).json({ message: "forbidden" });
        return;
      }
      state.suggestions.delete(suggestion.id);
      pushActivity(trip.id, userId, "suggestion_deleted", {
        title: suggestion.title,
      });
      res.status(204).end();
    },
  );

  app.get(
    "/api/v1/trips/:id/activity",
    requireAuth,
    (req: AuthedRequest, res) => {
      const tripId = param(req, "id");
      const limit = Number(req.query.limit ?? 50);
      const items = state.activity
        .filter((a) => a.trip_id === tripId)
        .slice(-limit)
        .reverse();
      res.json({ activity: items });
    },
  );

  // ── Trip collaborators (People tab roster) ───────────────────────
  app.get(
    "/api/v1/trips/:id/members",
    requireAuth,
    (req: AuthedRequest, res) => {
      const tripId = param(req, "id");
      const trip = state.trips.get(tripId);
      if (!trip) {
        res.status(404).json({ message: "Trip not found" });
        return;
      }
      const members = trip.members.map((userId) => {
        const user = state.users.get(userId);
        return {
          user_id: userId,
          display_name: user?.display_name ?? "Rider",
          email: user?.email ?? null,
          avatar_url: null,
          role: userId === trip.owner_id ? "owner" : "editor",
          joined_at: trip.created_at,
          state: "joined",
        };
      });
      res.json({ members, invites: [] });
    },
  );

  // ── Trip shares ───────────────────────────────────────────────────
  app.post("/api/v1/trip-shares", requireAuth, (req: AuthedRequest, res) => {
    const id = randomUUID();
    const token = randomUUID();
    const now = new Date().toISOString();
    const share = {
      id,
      share_token: token,
      trip_id:
        typeof req.body?.trip_id === "string" ? String(req.body.trip_id) : null,
      title: String(req.body?.title ?? "Untitled trip"),
      snapshot: req.body?.snapshot ?? {},
      view_count: 0,
      created_at: now,
      updated_at: now,
    };
    state.shares.set(id, share);
    state.sharesByToken.set(token, share);
    res.status(201).json({
      id,
      share_token: token,
      share_url: `/trips/shared/${token}`,
      trip_id: share.trip_id,
      title: share.title,
      view_count: 0,
      created_at: now,
      updated_at: now,
    });
  });

  app.get("/api/v1/trip-shares/mine", requireAuth, (_req, res) => {
    const items = [...state.shares.values()].map((s) => ({
      id: s.id,
      share_token: s.share_token,
      share_url: `/trips/shared/${s.share_token}`,
      trip_id: s.trip_id,
      title: s.title,
      view_count: s.view_count,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));
    res.json({ items, total: items.length });
  });

  app.get("/api/v1/trip-shares/:token", (req, res) => {
    const share = state.sharesByToken.get(param(req, "token"));
    if (!share) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    share.view_count += 1;
    res.json({
      share_token: share.share_token,
      trip_id: share.trip_id,
      title: share.title,
      owner_name: "Test Owner",
      snapshot: share.snapshot,
      view_count: share.view_count,
      created_at: share.created_at,
      updated_at: share.updated_at,
    });
  });

  app.post(
    "/api/v1/trip-shares/:token/join",
    requireAuth,
    (req: AuthedRequest, res) => {
      const share = state.sharesByToken.get(param(req, "token"));
      const trip = share?.trip_id ? state.trips.get(share.trip_id) : null;
      if (!share) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (!trip) {
        res.status(400).json({ message: "read-only-share" });
        return;
      }
      const userId = req.session!.user_id;
      if (!trip.members.includes(userId)) {
        trip.members.push(userId);
        pushActivity(trip.id, userId, "member_joined", {
          source: "trip_share",
          share_token: share.share_token,
        });
      }
      res.status(201).json({
        trip_id: trip.id,
        planner_url: `/trips/planner?tripId=${trip.id}`,
      });
    },
  );

  // ── Account ───────────────────────────────────────────────────────
  app.get(
    "/api/v1/account/subscription",
    requireAuth,
    (req: AuthedRequest, res) => {
      res.json(describeSubscription(req.session!.user_id));
    },
  );

  app.post(
    "/api/v1/account/subscription/checkout",
    requireAuth,
    (req: AuthedRequest, res) => {
      const tier = String(req.body?.tier ?? "premium");
      const url = `https://checkout.stripe.test/session/${randomUUID()}`;
      state.lastCheckoutSession = {
        user_id: req.session!.user_id,
        url,
        tier,
      };
      res.json({ url });
    },
  );

  app.post(
    "/api/v1/account/subscription/portal",
    requireAuth,
    (req: AuthedRequest, res) => {
      const flow = String(req.body?.flow ?? "manage");
      const url = `https://billing.stripe.test/p/${randomUUID()}?flow=${encodeURIComponent(flow)}`;
      state.lastPortalSession = {
        user_id: req.session!.user_id,
        url,
        flow,
      };
      res.json({ url });
    },
  );

  app.get("/api/v1/account/bikes", requireAuth, (req: AuthedRequest, res) => {
    const list = state.bikes.get(req.session!.user_id) ?? [];
    res.json(list);
  });

  app.post("/api/v1/account/bikes", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.user_id;
    const list = state.bikes.get(userId) ?? [];
    const { make, model, year, photo_url, is_active } = req.body ?? {};
    const bike = {
      id: randomUUID(),
      make: String(make ?? ""),
      model: String(model ?? ""),
      year: Number(year ?? new Date().getFullYear()),
      photoUrl: photo_url ?? null,
      isActive: list.length === 0 || Boolean(is_active),
      totalRides: 0,
      totalKm: 0,
    };
    if (bike.isActive) for (const b of list) b.isActive = false;
    list.push(bike);
    state.bikes.set(userId, list);
    res.status(201).json(bike);
  });

  app.patch(
    "/api/v1/account/bikes/:id",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const list = state.bikes.get(userId) ?? [];
      const bike = list.find((b) => b.id === param(req, "id"));
      if (!bike) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      Object.assign(bike, {
        make: req.body?.make ?? bike.make,
        model: req.body?.model ?? bike.model,
        year: req.body?.year ?? bike.year,
        photoUrl: req.body?.photo_url ?? bike.photoUrl,
      });
      if (req.body?.is_active === true) {
        for (const b of list) b.isActive = b.id === bike.id;
      }
      res.json(bike);
    },
  );

  app.delete(
    "/api/v1/account/bikes/:id",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const list = state.bikes.get(userId) ?? [];
      const idx = list.findIndex((b) => b.id === param(req, "id"));
      if (idx < 0) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const wasActive = list[idx]?.isActive;
      list.splice(idx, 1);
      const first = list[0];
      if (wasActive && first) first.isActive = true;
      state.bikes.set(userId, list);
      res.status(204).end();
    },
  );

  app.get("/api/v1/account/privacy", requireAuth, (req: AuthedRequest, res) => {
    res.json(state.privacy.get(req.session!.user_id));
  });

  app.put("/api/v1/account/privacy", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.user_id;
    const current = state.privacy.get(userId)!;
    const next = { ...current };
    for (const key of Object.keys(req.body ?? {})) {
      (next as Record<string, unknown>)[key] = (
        req.body as Record<string, unknown>
      )[key];
    }
    state.privacy.set(userId, next);
    res.json(next);
  });

  app.get(
    "/api/v1/me/notification-preferences",
    requireAuth,
    (req: AuthedRequest, res) => {
      res.json(state.notifications.get(req.session!.user_id));
    },
  );

  app.put(
    "/api/v1/me/notification-preferences",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const current = state.notifications.get(userId)!;
      const next = {
        ...current,
        ...(req.body ?? {}),
        categories: { ...current.categories, ...(req.body?.categories ?? {}) },
      };
      state.notifications.set(userId, next);
      res.json(next);
    },
  );

  app.get(
    "/api/v1/me/notifications",
    requireAuth,
    (req: AuthedRequest, res) => {
      const items = state.inAppNotifications.get(req.session!.user_id) ?? [];
      res.json({
        items,
        unread_count: items.filter((item) => item.read_at == null).length,
      });
    },
  );

  app.patch(
    "/api/v1/me/notifications/read-all",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const items = state.inAppNotifications.get(userId) ?? [];
      const now = new Date().toISOString();
      const next = items.map((item) =>
        item.read_at ? item : { ...item, read_at: now },
      );
      state.inAppNotifications.set(userId, next);
      res.json({
        items: next,
        unread_count: 0,
      });
    },
  );

  app.patch(
    "/api/v1/me/notifications/:id/read",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const items = state.inAppNotifications.get(userId) ?? [];
      const id = param(req, "id");
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const next = [...items];
      const target = next[index];
      if (target) {
        next[index] = {
          ...target,
          read_at: target.read_at ?? new Date().toISOString(),
        };
      }
      state.inAppNotifications.set(userId, next);
      res.json(next[index]);
    },
  );

  app.post(
    "/api/v1/account/data-export",
    requireAuth,
    (req: AuthedRequest, res) => {
      const userId = req.session!.user_id;
      const id = randomUUID();
      const now = new Date().toISOString();
      const view = {
        id,
        user_id: userId,
        status: "ready" as const,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        createdAt: now,
        completedAt: now,
        downloadUrl: `https://exports.tarmoto.test/${id}.zip`,
        byteSize: 1024 * 32,
        errorMessage: null,
      };
      state.dataExports.set(id, view);
      const { user_id: _u, ...client } = view;
      void _u;
      // OpenAPI contract returns 202 (`Accepted`) — the typed
      // client `openApiData<DataExportRequestView>` reads that
      // exact response code. 200 here would surface as an error
      // branch on the typed-fetch wrapper, trapping the settings
      // page on "Could not start export" even when the body is
      // a valid ready view.
      res.status(202).json(client);
    },
  );

  app.get(
    "/api/v1/account/data-export/:id",
    requireAuth,
    (req: AuthedRequest, res) => {
      const view = state.dataExports.get(param(req, "id"));
      if (!view) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      const { user_id: _u, ...client } = view;
      void _u;
      res.json(client);
    },
  );

  app.delete("/api/v1/account", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.user_id;
    const user = state.users.get(userId);
    if (!user) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    if (req.body?.password !== user.password) {
      res.status(401).json({ message: "Wrong password" });
      return;
    }
    state.deletedUsers.add(userId);
    res.json({
      status: "scheduled",
      scheduled_for: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      grace_period_days: 30,
    });
  });

  // The planner + explorer poll these public-ish endpoints to render
  // the closures + passes panels. `useClosures(travelMonth, routes)`
  // hits both `GET /closures` (bbox-filtered list) AND
  // `POST /closures/check-route` (route intersection check); a test
  // seeding a closure expects both calls to surface the row.
  //
  // Production `ListClosuresQueryDto.active_on` /
  // `CheckRouteClosuresDto.active_on` both apply `@IsISO8601`.
  // Without an explicit guard the mock would feed a malformed
  // string into `new Date(...)` (e.g. `Invalid Date`), then
  // `filterActiveOn` would drop every closure and the test would
  // silently land on the empty-state path. Returns the validated
  // string on success, sends 400 on failure (and returns null so
  // the caller bails out).
  // Strict ISO 8601 (date or date+time, optional ms + tz). Mirrors
  // class-validator's `@IsISO8601` — `Date.parse` is too lenient
  // (it accepts `1` or `2026-7-5`), so we filter through the regex
  // first and only then sanity-check the resulting Date.
  const ISO_8601_REGEX =
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  function parseActiveOn(
    raw: unknown,
    res: import("express").Response,
  ): string | null | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || !ISO_8601_REGEX.test(raw)) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "active_on must be an ISO 8601 date string",
      });
      return null;
    }
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "active_on must be an ISO 8601 date string",
      });
      return null;
    }
    return raw;
  }

  // Both paths share the production `active_on` filter:
  //   starts_at <= activeOn AND (ends_at IS NULL OR ends_at >= activeOn)
  // `include_past=true` (list endpoint) opts out entirely.
  function filterActiveOn(
    closures: Iterable<import("./state").MockRoadClosure>,
    activeOnIso: string | undefined,
  ): import("./state").MockRoadClosure[] {
    const activeOn = activeOnIso ? new Date(activeOnIso) : new Date();
    const t = activeOn.getTime();
    return [...closures].filter(
      (c) =>
        new Date(c.starts_at).getTime() <= t &&
        (c.ends_at == null || new Date(c.ends_at).getTime() >= t),
    );
  }
  app.get("/api/v1/closures", (req, res) => {
    const includePast = req.query.include_past === "true";
    const activeOn = parseActiveOn(req.query.active_on, res);
    if (activeOn === null) return;
    let rows = includePast
      ? [...state.closures.values()]
      : filterActiveOn(state.closures.values(), activeOn);
    // Mirror production `ClosuresService.list` filters: bbox
    // (intersection), severity (exact match), reason (exact
    // match). Without these, an e2e seeding an out-of-region or
    // off-severity closure would still see it surface, drifting
    // from what the real backend would return.
    if (typeof req.query.bbox === "string") {
      // Mirror production: `ListClosuresQueryDto.bbox` matches
      // `/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$/` (exactly four
      // numeric tokens separated by commas). Splitting + `Number()`
      // on its own coerces blank parts like `10,,11,12` to `0` and
      // passes the finite check, so explicitly require non-empty
      // numeric tokens before parsing.
      const rawParts = req.query.bbox.split(",");
      const parts =
        rawParts.length === 4 &&
        rawParts.every((s) => s.trim().length > 0 && Number.isFinite(Number(s)))
          ? rawParts.map(Number)
          : null;
      if (parts === null) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: 'bbox must be "minLng,minLat,maxLng,maxLat"',
        });
        return;
      }
      const [minLng, minLat, maxLng, maxLat] = parts as [
        number,
        number,
        number,
        number,
      ];
      if (minLng >= maxLng || minLat >= maxLat) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "bbox min must be strictly less than max for both axes",
        });
        return;
      }
      // Exact segment-vs-rectangle intersection so a closure whose
      // vertices are both outside the bbox but whose segment crosses
      // through still matches — mirrors `ST_Intersects(c.geom,
      // envelope)`.
      rows = rows.filter((c) =>
        polylineIntersectsBbox(c.geometry, minLng, minLat, maxLng, maxLat),
      );
    }
    // Mirror production `ListClosuresQueryDto` enum guards
    // (`@IsIn(ROAD_CLOSURE_SEVERITIES)`,
    // `@IsIn(ROAD_CLOSURE_REASONS)`). A bad value like
    // `severity=closed` or `reason=construction` now surfaces 400
    // instead of silently filtering to an empty list.
    const VALID_SEVERITIES = new Set(["advisory", "partial", "full"]);
    const VALID_REASONS = new Set([
      "closure",
      "roadworks",
      "seasonal",
      "weather",
      "event",
      "other",
    ]);
    if (typeof req.query.severity === "string") {
      if (!VALID_SEVERITIES.has(req.query.severity)) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "severity must be one of: advisory, partial, full",
        });
        return;
      }
      rows = rows.filter((c) => c.severity === req.query.severity);
    }
    if (typeof req.query.reason === "string") {
      if (!VALID_REASONS.has(req.query.reason)) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message:
            "reason must be one of: closure, roadworks, seasonal, weather, event, other",
        });
        return;
      }
      rows = rows.filter((c) => c.reason === req.query.reason);
    }
    res.json(rows);
  });
  app.post("/api/v1/closures/check-route", (req, res) => {
    // Simplification: any seeded closure is reported as crossing the
    // supplied route. The mock doesn't run a geometry intersection —
    // tests seed a single closure conceptually-over the trip route
    // and assert on the rendered "Current trip crosses N closures"
    // copy, not on coordinate math.
    const route = (req.body?.route ?? []) as Array<{
      lat: number;
      lng: number;
    }>;
    // Production `CheckRouteClosuresDto` requires `@ArrayMinSize(2)`
    // AND `ClosuresService.checkRoute` throws `BadRequestException
    // ("Route must have at least 2 points")` for shorter polylines.
    // Mirror that so a planner regression that ships a degenerate
    // single-point route surfaces the same 400 instead of silently
    // getting a closure list back.
    if (route.length < 2) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "Route must have at least 2 points",
      });
      return;
    }
    // Mirror `ClosurePointDto`: `@IsLatitude` (lat ∈ [-90, 90])
    // and `@IsLongitude` (lng ∈ [-180, 180]) plus both fields
    // required and finite. Without this guard a missing or
    // corrupted coordinate would fall through as `NaN`/`undefined`
    // and the proximity math would still produce a 200 (usually
    // with zero matches) — masking a planner regression where
    // generated geometry drops a field.
    for (let i = 0; i < route.length; i++) {
      const pt = route[i] as unknown;
      if (
        !pt ||
        typeof pt !== "object" ||
        typeof (pt as { lat: unknown }).lat !== "number" ||
        typeof (pt as { lng: unknown }).lng !== "number" ||
        !Number.isFinite((pt as { lat: number }).lat) ||
        !Number.isFinite((pt as { lng: number }).lng) ||
        (pt as { lat: number }).lat < -90 ||
        (pt as { lat: number }).lat > 90 ||
        (pt as { lng: number }).lng < -180 ||
        (pt as { lng: number }).lng > 180
      ) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: `route[${i}] must have lat ∈ [-90, 90] and lng ∈ [-180, 180]`,
        });
        return;
      }
    }
    const activeOn = parseActiveOn(req.body?.active_on, res);
    if (activeOn === null) return;
    // Mirror `CheckRouteClosuresDto.buffer_m`: `@IsNumber()`,
    // `@Min(10)`, `@Max(5000)`. The mock previously accepted any
    // number, which lets a client regression pass with `0` /
    // negative / over-cap values that production 400s.
    const rawBuffer = req.body?.buffer_m;
    if (rawBuffer !== undefined) {
      if (typeof rawBuffer !== "number" || !Number.isFinite(rawBuffer)) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "buffer_m must be a finite number",
        });
        return;
      }
      if (rawBuffer < 10 || rawBuffer > 5000) {
        res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "buffer_m must be between 10 and 5000",
        });
        return;
      }
    }
    const bufferM =
      typeof rawBuffer === "number" && Number.isFinite(rawBuffer)
        ? rawBuffer
        : 100;
    const bufferKm = bufferM / 1000;
    // Exact polyline-polyline min distance, so segments running
    // parallel-but-close to the route, or crossing through the
    // route between their vertices, still match — mirrors
    // `ST_DWithin(c.geom, route.geom, buffer_m)` without any
    // sampling tolerance.
    const matched = filterActiveOn(state.closures.values(), activeOn).filter(
      (c) => polylinesMinKm(c.geometry, route) <= bufferKm,
    );
    // Mirror `CheckRouteClosuresResponseDto`: `closures` plus per-
    // severity counts so consumers reading the count fields hit
    // numbers instead of `undefined`.
    let fullCount = 0;
    let partialCount = 0;
    let advisoryCount = 0;
    for (const c of matched) {
      if (c.severity === "full") fullCount += 1;
      else if (c.severity === "partial") partialCount += 1;
      else if (c.severity === "advisory") advisoryCount += 1;
    }
    res.json({
      closures: matched,
      full_count: fullCount,
      partial_count: partialCount,
      advisory_count: advisoryCount,
    });
  });
  app.get("/api/v1/passes", (_req, res) => {
    res.json([]);
  });
  app.get("/api/v1/hazards", (_req, res) => {
    res.json([]);
  });
  app.get("/api/v1/exploration/stats", requireAuth, (_req, res) => {
    res.json({
      ridden_segments: 0,
      total_segments: 0,
      percent_explored: 0,
      total_distance_km: 0,
    });
  });
  app.get("/api/v1/exploration/ridden-ids", requireAuth, (_req, res) => {
    res.json({ segment_ids: [] });
  });
  app.get("/api/v1/exploration/ridden-segments", requireAuth, (_req, res) => {
    res.json({ segments: [] });
  });
  app.get("/api/v1/exploration/nearby-unridden", requireAuth, (_req, res) => {
    res.json([]);
  });

  // ── Community feed ───────────────────────────────────────────────
  // Production `SharingController.listCommunityRides` is an anonymous
  // endpoint — no `@UseGuards(AuthGuard)`. It reads `SharedRide` rows
  // with `sr.is_public = true` and joins to the ride row. The mock
  // mirrors that by scanning `state.rideShares` for public entries
  // and serializing each backing ride as a community card. Empty
  // state remains the default when nothing is seeded.
  app.get("/api/v1/rides/community", (req, res) => {
    const q = req.query;
    // Optional auth — personalises `viewer_has_liked` when a token is present.
    const session = state.resolveSession(req.header("authorization"));
    // `SharingService.listCommunityRides` defaults to `?? 20` when
    // the caller omits `limit`. The companion's feed page sends its
    // own PAGE_SIZE of 9, but API-only consumers + tests that rely
    // on the backend default get the matching 20-row first page.
    const limit = Math.max(0, Number(q.limit ?? 20));
    const offset = Math.max(0, Number(q.offset ?? 0));
    // `SharingService.listCommunityRides` defaults to `newest` when
    // the caller omits `sort` (`query.sort ?? 'newest'`). Match that
    // so API-only consumers + the few companion paths that don't
    // serialize a sort still see the same default order the backend
    // returns.
    const sort = String(q.sort ?? "newest");
    // Companion-side `buildCommunityRideQuery` ships these filters;
    // production applies each as a SQL predicate before paging
    // (`SharingService.listCommunityRides`). Parse once so the inner
    // loop stays linear.
    const filterRideType = q.ride_type ? String(q.ride_type) : null;
    const filterMinQuality =
      q.min_quality != null ? Number(q.min_quality) : null;
    const filterMinPopularity =
      q.min_popularity != null ? Number(q.min_popularity) : null;
    const filterMinDistance =
      q.min_distance_km != null ? Number(q.min_distance_km) : null;
    const filterMaxDistance =
      q.max_distance_km != null ? Number(q.max_distance_km) : null;
    // Location filter: production activates spatial filtering as
    // soon as `lat` + `lng` are present, defaulting `radius_km` to
    // 25 km. The companion always sends all three together, but
    // API-only consumers (or tests that mimic them) can omit the
    // radius and still expect filtering + nearest-sort to kick in.
    const filterLat = q.lat != null ? Number(q.lat) : null;
    const filterLng = q.lng != null ? Number(q.lng) : null;
    const rawRadius = q.radius_km != null ? Number(q.radius_km) : null;
    const latValid = filterLat != null && Number.isFinite(filterLat);
    const lngValid = filterLng != null && Number.isFinite(filterLng);
    // Production `CommunityRidesQueryDto` requires both coordinates
    // whenever `sort === 'nearest'` (`@ValidateIf((o) => ... || o.sort
    // === 'nearest')` + `@IsLatitude`/`@IsLongitude`) AND when one
    // coordinate is supplied without the other (so we never run a
    // half-defined spatial query). Reject the same way — a 400 here
    // surfaces companion bugs (e.g. the nearest option leaking
    // through after the place is cleared) instead of letting the mock
    // silently re-sort to popularity.
    if (sort === "nearest" && !(latValid && lngValid)) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "nearest sort requires lat and lng",
      });
      return;
    }
    if (latValid !== lngValid) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "lat and lng must be provided together",
      });
      return;
    }
    const locationActive = latValid && lngValid;
    const filterRadiusKm = locationActive
      ? rawRadius != null && Number.isFinite(rawRadius)
        ? rawRadius
        : 25
      : null;
    const filterMinCurviness =
      q.min_curviness != null ? Number(q.min_curviness) : null;
    const filterMaxCurviness =
      q.max_curviness != null ? Number(q.max_curviness) : null;

    const all: Array<{
      ride: import("./state").MockRide;
      share: { token: string; view_count: number };
    }> = [];
    for (const [token, share] of state.rideShares.entries()) {
      if (!share.is_public) continue;
      const ride = state.rides.get(share.ride_id);
      if (!ride) continue;
      // `SharingService.listCommunityRides` excludes rides whose
      // owner has been soft-deleted or whose profile is private —
      // production hides their cards from the public feed even when
      // the share row stays public.
      if (state.deletedUsers.has(ride.user_id)) continue;
      const ownerPrivacy = state.privacy.get(ride.user_id);
      if (ownerPrivacy?.profile_visibility === "private") continue;

      // Filter predicates — each mirrors the corresponding SQL
      // clause in `applyCommunityRidesFilters`.
      if (filterRideType && ride.ride_type !== filterRideType) continue;
      if (
        filterMinQuality != null &&
        ride.avg_road_quality < filterMinQuality
      ) {
        continue;
      }
      if (
        filterMinPopularity != null &&
        share.view_count < filterMinPopularity
      ) {
        continue;
      }
      if (filterMinDistance != null && ride.distance_km < filterMinDistance) {
        continue;
      }
      if (filterMaxDistance != null && ride.distance_km > filterMaxDistance) {
        continue;
      }
      // `applyCommunityRidesFilters` uses `ride.avg_curviness IS NOT
      // NULL AND ride.avg_curviness >= :min_curviness` — both halves
      // matter: a ride with `null` curviness is dropped by the filter
      // even if the threshold is 0.
      if (filterMinCurviness != null) {
        if (ride.avg_curviness == null) continue;
        if (ride.avg_curviness < filterMinCurviness) continue;
      }
      // `max_curviness` uses the same `IS NOT NULL AND <= :max` shape:
      // null-curviness rides are excluded even when the cap is high,
      // mirroring production.
      if (filterMaxCurviness != null) {
        if (ride.avg_curviness == null) continue;
        if (ride.avg_curviness > filterMaxCurviness) continue;
      }
      if (locationActive) {
        // No route geometry ⇒ can't satisfy `ST_DWithin`; drop the
        // ride from the location-scoped feed, matching production.
        if (ride.route_geometry.length === 0) continue;
        const dist = kmToPolyline(
          { lat: filterLat!, lng: filterLng! },
          ride.route_geometry,
        );
        if (dist > filterRadiusKm!) continue;
      }

      all.push({ ride, share: { token, view_count: share.view_count } });
    }
    // Sort comparators mirror `SharingService.applySort` predicate-
    // by-predicate. Every CommunityRideSort the companion ships has
    // a real ORDER BY in production:
    //   newest          → started_at DESC, ride.id DESC
    //   oldest          → started_at ASC,  ride.id ASC
    //   longest         → distance_km DESC, ride.id DESC
    //   shortest        → distance_km ASC,  ride.id ASC
    //   highest_quality → avg_road_quality DESC, ride.id DESC
    //   curviest        → avg_curviness DESC NULLS LAST, ride.id DESC
    //   most_popular    → view_count DESC, ride.id DESC (default)
    //   nearest         → polyline-to-center ASC, ride.id ASC (only
    //                     when the location filter is active)
    // Tiebreaker direction matches the primary key's direction so
    // ties paginate in the same order the backend serves them.
    const idTiebreak = (
      a: { ride: { id: string } },
      b: { ride: { id: string } },
      direction: "asc" | "desc",
    ) =>
      direction === "asc"
        ? a.ride.id.localeCompare(b.ride.id)
        : b.ride.id.localeCompare(a.ride.id);
    all.sort((a, b) => {
      switch (sort) {
        case "nearest": {
          if (!locationActive) break;
          const da = kmToPolyline(
            { lat: filterLat!, lng: filterLng! },
            a.ride.route_geometry,
          );
          const db = kmToPolyline(
            { lat: filterLat!, lng: filterLng! },
            b.ride.route_geometry,
          );
          const dd = da - db;
          return dd !== 0 ? dd : idTiebreak(a, b, "asc");
        }
        case "newest": {
          const dt = b.ride.started_at.localeCompare(a.ride.started_at);
          return dt !== 0 ? dt : idTiebreak(a, b, "desc");
        }
        case "oldest": {
          const dt = a.ride.started_at.localeCompare(b.ride.started_at);
          return dt !== 0 ? dt : idTiebreak(a, b, "asc");
        }
        case "longest": {
          const dd = b.ride.distance_km - a.ride.distance_km;
          return dd !== 0 ? dd : idTiebreak(a, b, "desc");
        }
        case "shortest": {
          const dd = a.ride.distance_km - b.ride.distance_km;
          return dd !== 0 ? dd : idTiebreak(a, b, "asc");
        }
        case "highest_quality": {
          const dq = b.ride.avg_road_quality - a.ride.avg_road_quality;
          return dq !== 0 ? dq : idTiebreak(a, b, "desc");
        }
        case "curviest": {
          // NULLS LAST: rides without a curviness reading sort after
          // those with one regardless of direction.
          const av = a.ride.avg_curviness;
          const bv = b.ride.avg_curviness;
          if (av == null && bv == null) return idTiebreak(a, b, "desc");
          if (av == null) return 1;
          if (bv == null) return -1;
          const dc = bv - av;
          return dc !== 0 ? dc : idTiebreak(a, b, "desc");
        }
        // most_popular (default).
      }
      const dv = b.share.view_count - a.share.view_count;
      return dv !== 0 ? dv : idTiebreak(a, b, "desc");
    });
    const page = all.slice(offset, offset + limit);
    res.json({
      items: page.map(({ ride, share }) => {
        const owner = state.users.get(ride.user_id);
        return {
          id: ride.id,
          share_token: share.token,
          rider_id: ride.user_id,
          rider_name: owner?.display_name ?? "Anonymous Rider",
          rider_avatar_url: null,
          name: ride.name ?? null,
          ride_type: ride.ride_type,
          started_at: ride.started_at,
          distance_km: ride.distance_km,
          avg_speed: ride.avg_speed,
          avg_road_quality: ride.avg_road_quality,
          avg_curviness: ride.avg_curviness,
          duration_min: deriveDurationMin(ride),
          view_count: share.view_count,
          description: null,
          like_count: state.rideLikes.get(ride.id)?.size ?? 0,
          viewer_has_liked: Boolean(
            session && state.rideLikes.get(ride.id)?.has(session.user_id),
          ),
          clone_count: state.rideClones.get(ride.id) ?? 0,
          route_geometry: ride.route_geometry,
        };
      }),
      total: all.length,
      limit,
      offset,
    });
  });

  // Community route engagement: idempotent hearts + clone-to-trips.
  app.post(
    "/api/v1/rides/:rideId/like",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const rideId = param(req, "rideId");
      const set = state.rideLikes.get(rideId) ?? new Set<string>();
      set.add(session.user_id);
      state.rideLikes.set(rideId, set);
      res.status(201).json({ like_count: set.size, viewer_has_liked: true });
    },
  );
  app.delete(
    "/api/v1/rides/:rideId/like",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const rideId = param(req, "rideId");
      const set = state.rideLikes.get(rideId) ?? new Set<string>();
      set.delete(session.user_id);
      state.rideLikes.set(rideId, set);
      res.json({ like_count: set.size, viewer_has_liked: false });
    },
  );
  app.post(
    "/api/v1/rides/:rideId/clone",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const rideId = param(req, "rideId");
      const count = (state.rideClones.get(rideId) ?? 0) + 1;
      state.rideClones.set(rideId, count);
      // Mirror production: cloning seeds a real draft trip owned by the caller
      // so the post-clone navigation to `/trips/:id` resolves instead of
      // 404-ing. Title follows the source ride name like the backend does.
      const ride = state.rides.get(rideId);
      const now = new Date().toISOString();
      const id = randomUUID();
      const trip = {
        id,
        owner_id: session.user_id,
        title: ride?.name?.trim() || "Cloned route",
        num_days: 1,
        status: "draft" as const,
        members: [session.user_id],
        snapshot: {},
        created_at: now,
        updated_at: now,
      };
      state.trips.set(id, trip);
      res.status(201).json({ trip_id: id, clone_count: count });
    },
  );

  // "People you might follow" — riders the caller doesn't already follow.
  app.get(
    "/api/v1/users/suggestions",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const following = state.userFollows.get(session.user_id) ?? new Map();
      const limit = Math.min(Math.max(Number(req.query.limit ?? 6), 1), 20);
      const out: Array<{
        id: string;
        display_name: string;
        avatar_url: string | null;
        home_region: string | null;
        ride_count: number;
      }> = [];
      for (const [id, user] of state.users) {
        if (id === session.user_id || following.has(id)) continue;
        out.push({
          id,
          display_name: user.display_name,
          avatar_url: null,
          home_region: user.home_region ?? null,
          ride_count: 0,
        });
        if (out.length >= limit) break;
      }
      res.json(out);
    },
  );

  // Public collection discovery feed (search + follower counts).
  app.get("/api/v1/collections/discover", (req, res) => {
    const session = state.resolveSession(req.header("authorization"));
    const q = String(req.query.q ?? "").toLowerCase();
    const items = [...state.collections.values()]
      .filter((c) => c.visibility === "public")
      // Mirror production `listDiscover`: signed-in viewers don't see their
      // own collections in Discover (they live under "Your collections").
      .filter((c) => !session || c.owner_id !== session.user_id)
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map((c) => {
        const followers = state.collectionFollows.get(c.id) ?? new Map();
        return {
          id: c.id,
          slug: c.slug,
          title: c.title,
          description: c.description ?? null,
          owner_id: c.owner_id,
          owner_name: state.users.get(c.owner_id)?.display_name ?? null,
          item_count: 0,
          follower_count: followers.size,
          viewer_is_following: Boolean(
            session && followers.has(session.user_id),
          ),
          updated_at: c.updated_at,
        };
      });
    res.json({ items, total: items.length, limit: 12, offset: 0 });
  });

  // ── Route collections ────────────────────────────────────────────
  // Public shared-collection view is registered BEFORE the authed
  // `:id` route so the literal `by-slug` path segment isn't captured
  // as a collection id.
  app.get("/api/v1/collections/by-slug/:slug", (req, res) => {
    const collectionId = state.collectionsBySlug.get(param(req, "slug"));
    const collection = collectionId
      ? state.collections.get(collectionId)
      : null;
    if (
      !collection ||
      (collection.visibility !== "public" &&
        collection.visibility !== "unlisted")
    ) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    // Production `RouteCollectionsService.getBySlug` 404s when the
    // owner has been soft-deleted (`deletedUsers` here) — a deleted
    // rider's shared collection should disappear regardless of
    // visibility.
    if (state.deletedUsers.has(collection.owner_id)) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    // Production runs `OptionalAuthGuard` here: the bearer token is
    // read if present, and the viewer's identity feeds
    // `viewer_is_owner` / `viewer_is_following` so the page can render
    // the right CTA. Mirror that — fall back to anonymous if no token.
    const session = state.resolveSession(req.header("authorization"));
    const viewerOwns =
      session != null && session.user_id === collection.owner_id;
    // Privacy masking: `toSummaryResponse` returns `owner_id: null` +
    // `owner_name: null` for non-self viewers when the owner's
    // `profile_visibility` is private. The viewer always sees their
    // own row unmasked, even via the public-slug path.
    const ownerPrivacy = state.privacy.get(collection.owner_id);
    const maskOwner =
      ownerPrivacy?.profile_visibility === "private" && !viewerOwns;
    // `viewer_is_following` reflects the signed-in viewer's follow
    // state — anonymous and the owner themselves always see false.
    const viewerIsFollowing =
      session != null && !viewerOwns
        ? (state.collectionFollows.get(session.user_id)?.has(collection.id) ??
          false)
        : false;
    res.json(
      serializeCollectionDetail(collection, viewerOwns, {
        maskOwner,
        viewerIsFollowing,
        followerCount: countCollectionFollowers(
          state.collectionFollows,
          collection.id,
        ),
      }),
    );
  });

  // Public preview geometries for the shared-collection page —
  // `CollectionPreviewMap` fetches this on mount. Production
  // `RouteCollectionsController.getPreviewBySlug` is unauthenticated
  // and mirrors the by-slug visibility gates (404 on private,
  // 404 on soft-deleted owner). Items live in `route_collection_items`
  // which the mock doesn't model, so the response is the natural
  // empty-collection shape `{ routes: [] }` — same payload production
  // returns for a public collection with zero items.
  app.get("/api/v1/collections/by-slug/:slug/preview", (req, res) => {
    const collectionId = state.collectionsBySlug.get(param(req, "slug"));
    const collection = collectionId
      ? state.collections.get(collectionId)
      : null;
    if (
      !collection ||
      (collection.visibility !== "public" &&
        collection.visibility !== "unlisted") ||
      state.deletedUsers.has(collection.owner_id)
    ) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    res.json({ routes: [] });
  });

  // Owner-by-id preview — mirrors `RouteCollectionsController.getPreviewOwned`:
  // authed, owner-only (404 for a missing collection or a non-owner, any
  // visibility). Items aren't modelled in the mock, so the natural empty shape
  // `{ routes: [] }` — same as the slug preview.
  app.get(
    "/api/v1/collections/:id/preview",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const collection = state.collections.get(param(req, "id"));
      if (!collection || collection.owner_id !== session.user_id) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      res.json({ routes: [] });
    },
  );

  app.get("/api/v1/collections/me", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    // `ownedByViewer: true` nulls `owner_name` — matches
    // `RouteCollectionsService.toSummaryResponse` on the self-owned
    // endpoints. Order by `updated_at` DESC to match production
    // `RouteCollectionsService.listMine`'s `ORDER BY c.updated_at
    // DESC`; `Map` insertion order would otherwise hand back the
    // oldest row first and let an e2e assert reversed ordering.
    const items = [...state.collections.values()]
      .filter((c) => c.owner_id === session.user_id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((c) => serializeCollectionSummary(c, { ownedByViewer: true }));
    res.json({ items, total: items.length });
  });

  app.get(
    "/api/v1/collections/me/library",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      // `owned` is the rider's own rows → owner_name null. Production
      // builds this half by calling `listMine`, which orders
      // `c.updated_at DESC`; mirror the sort here so an e2e that
      // updates an older row sees it bubble to the top instead of the
      // mock's insertion order.
      const owned = [...state.collections.values()]
        .filter((c) => c.owner_id === session.user_id)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((c) => serializeCollectionSummary(c, { ownedByViewer: true }));
      // `followed` surfaces other riders' collections the viewer
      // already followed. Production `RouteCollectionsService
      // .listLibrary` drops rows whose owner has been soft-deleted
      // (the rider is effectively gone) but KEEPS rows owned by a
      // private rider — they're returned with `owner_id` and
      // `owner_name` masked to `null` so the saved card stays in
      // the library shelf without leaking identity.
      // Sort followed rows by `followed_at` DESC so the most
      // recently-followed collection sits at the top of the saved
      // library — matches `RouteCollectionsService.listLibrary`'s
      // `ORDER BY f.created_at DESC`. Iterating the inner map in
      // insertion order would surface the oldest follow first.
      const followsMap = state.collectionFollows.get(session.user_id);
      const followed = followsMap
        ? [...followsMap.entries()]
            .sort(([, a], [, b]) => b.localeCompare(a))
            .map(([id]) => state.collections.get(id))
            .filter((c): c is import("./state").MockCollection => c != null)
            // Soft-deleted owners → drop (rider is effectively gone).
            // Collections whose owner flipped `visibility` to private
            // → also drop (`listLibrary` uses `c.visibility <>
            // 'private'`; the shared slug would 404 anyway).
            .filter((c) => !state.deletedUsers.has(c.owner_id))
            .filter((c) => c.visibility !== "private")
            .map((c) => {
              const ownerPrivacy = state.privacy.get(c.owner_id);
              const maskOwner = ownerPrivacy?.profile_visibility === "private";
              return serializeCollectionSummary(c, { maskOwner });
            })
        : [];
      res.json({ owned, followed });
    },
  );

  // Follow / unfollow a collection. Production guards with auth +
  // looks up `route_collection_follows`; the mock mirrors that with a
  // per-user set in `state.collectionFollows`. Same precedence as
  // `/by-slug/:slug` — register before `:id` so the `:id` route
  // doesn't capture the `follow` path segment.
  app.post(
    "/api/v1/collections/:id/follow",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const collection = state.collections.get(param(req, "id"));
      if (!collection) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      // `RouteCollectionsService.follow` 404s when the collection is
      // private or the owner has been soft-deleted, BEFORE creating
      // the follow row. Mirror both checks so privacy-aware e2es
      // exercise the same paths the real backend serves.
      if (collection.visibility === "private") {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (state.deletedUsers.has(collection.owner_id)) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      // Owners can't follow their own collection — production rejects
      // with the same 400.
      if (collection.owner_id === session.user_id) {
        res.status(400).json({ message: "cannot-follow-own-collection" });
        return;
      }
      let follows = state.collectionFollows.get(session.user_id);
      if (!follows) {
        follows = new Map();
        state.collectionFollows.set(session.user_id, follows);
      }
      // `route_collection_follows` uses a UNIQUE (viewer, collection)
      // index — re-following keeps the original row, so preserve the
      // existing `followed_at` instead of bumping it on every POST.
      // Without this an e2e that follows → toggles UI → re-follows
      // would see the timestamp reset and the library reorder.
      const existing = follows.get(collection.id);
      const followedAt = existing ?? new Date().toISOString();
      if (!existing) {
        follows.set(collection.id, followedAt);
      }
      res.status(201).json({
        collection_id: collection.id,
        followed_at: followedAt,
      });
    },
  );

  app.delete(
    "/api/v1/collections/:id/follow",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const follows = state.collectionFollows.get(session.user_id);
      follows?.delete(param(req, "id"));
      res.status(204).end();
    },
  );

  // Create a new collection. Mirrors `CreateRouteCollectionDto`'s
  // shape: `title` required (non-empty, ≤80), `description?` (≤500),
  // `visibility?` defaulting to `'private'`. Slug is server-allocated
  // — production uses `allocateSlug()` + retry; the mock uses a
  // short uuid slice which is collision-free for test scope.
  app.post("/api/v1/collections", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const body = req.body ?? {};
    const rawTitle = body.title;
    if (
      typeof rawTitle !== "string" ||
      rawTitle.trim().length === 0 ||
      rawTitle.trim().length > 80
    ) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "title is required (1-80 chars)",
      });
      return;
    }
    const rawDescription = body.description;
    if (
      rawDescription != null &&
      (typeof rawDescription !== "string" || rawDescription.length > 500)
    ) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "description must be string (≤500 chars)",
      });
      return;
    }
    const rawVisibility = body.visibility;
    if (
      rawVisibility != null &&
      !["private", "unlisted", "public"].includes(String(rawVisibility))
    ) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "visibility must be private|unlisted|public",
      });
      return;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const created: import("./state").MockCollection = {
      id,
      owner_id: session.user_id,
      title: rawTitle.trim(),
      description:
        typeof rawDescription === "string" && rawDescription.trim().length > 0
          ? rawDescription
          : null,
      visibility:
        (rawVisibility as "private" | "unlisted" | "public" | undefined) ??
        "private",
      slug: `collection-${id.slice(0, 8)}`,
      created_at: now,
      updated_at: now,
    };
    state.collections.set(id, created);
    state.collectionsBySlug.set(created.slug, id);
    // POST returns the detail shape with owner_name hydrated — same
    // contract as `RouteCollectionsService.create` (re-reads with the
    // owner relation so the response carries `display_name`).
    res.status(201).json(serializeCollectionDetail(created, true));
  });

  app.get("/api/v1/collections/:id", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const collection = state.collections.get(param(req, "id"));
    // `RouteCollectionsService.getOwned` 404s every non-owner on the
    // id-based endpoint regardless of visibility — public/unlisted
    // viewing is exclusively `/collections/by-slug/:slug`. Mirror that
    // here so an e2e that accidentally hits the owner-only route as a
    // different rider fails the same way it would in production.
    if (!collection || collection.owner_id !== session.user_id) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    res.json(
      serializeCollectionDetail(collection, /* viewerOwns */ true, {
        followerCount: countCollectionFollowers(
          state.collectionFollows,
          collection.id,
        ),
      }),
    );
  });

  // Owner-only delete. Production responds 404 when the collection is
  // missing (id existence isn't a side channel), 403 when the caller
  // isn't the owner. Items + follows cascade via FK in the real DB —
  // the mock drops the slug index and any follow rows so an e2e that
  // deletes a collection doesn't leak stale state into a follow-up.
  app.delete(
    "/api/v1/collections/:id",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const collection = state.collections.get(param(req, "id"));
      if (!collection) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      if (collection.owner_id !== session.user_id) {
        res.status(403).json({ message: "not-the-owner" });
        return;
      }
      state.collections.delete(collection.id);
      state.collectionsBySlug.delete(collection.slug);
      // FK CASCADE on `route_collection_follows` → drop any follow
      // row referencing this collection so the library / follow flag
      // doesn't surface a dangling entry post-delete.
      for (const follows of state.collectionFollows.values()) {
        follows.delete(collection.id);
      }
      res.status(204).end();
    },
  );

  // ── Users / public profile / follows ─────────────────────────────
  // Backs `/community/[riderId]` (T38). `GET :userId/profile` carries
  // the `PublicProfile` wire shape; follow + badges + shared-rides
  // are auth-only sub-resources the page mounts alongside the
  // profile.

  // `GET /users/me` returns the rich `UserResponseDto` shape that
  // backs `/settings` (profile name + avatar + bio + home_region).
  // Production also serves this via auth login/register/refresh, but
  // the mock keeps the shorter tokenResponse on those flows; this is
  // the canonical place that surfaces `bio` + `home_region` for
  // settings rehydration.
  app.get("/api/v1/users/me", requireAuth, (req: AuthedRequest, res) => {
    const user = state.users.get(req.session!.user_id)!;
    // Client-enforced entitlements ride along on /users/me (see
    // `useEntitlements`): the companion gates Pro UI (advanced ride stats, GPX
    // import, collaborative trips, …) on `features`/`limits`. Resolve them from
    // the rider's subscription tier via the SAME shared registry builders the
    // real backend uses, so the mock never drifts as keys are added. Omitting
    // them (the prior behaviour) made every gated feature fail closed → the Pro
    // UI these e2e exercise was hidden/locked.
    const tier = state.subscriptions.get(user.id)?.tier ?? "free";
    res.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      phone: user.phone,
      avatar_url: user.avatar_url,
      bio: user.bio,
      home_region: user.home_region,
      home_location: null,
      work_location: null,
      preferences: user.preferences,
      created_at: user.created_at,
      subscription_tier: tier,
      features: buildFeatureSnapshot(tier, {}, {}),
      limits: buildLimitSnapshot(tier, {}, {}),
    });
  });

  // `GET /users/me/contribution` — the sidebar "Your contribution" badge.
  // Defaults to no contribution so the badge stays hidden across the suite
  // (the badge rendering is covered by the Sidebar unit tests); the endpoint
  // just needs to resolve so the fetch doesn't error in dashboard e2e.
  app.get(
    "/api/v1/users/me/contribution",
    requireAuth,
    (_req: AuthedRequest, res) => {
      res.json({
        km_mapped: 0,
        segments_mapped: 0,
        home_region: null,
        rank_in_region: null,
        region_rider_count: null,
        region_riders_behind: null,
        percentile: null,
      });
    },
  );

  // `PATCH /users/me` mutates the user's profile fields. Mirrors
  // production `UpdateProfileDto`:
  // - `display_name`: string, ≤100
  // - `phone`:        string, ≤20
  // - `avatar_url`:   string|null, ≤500
  // - `bio`:          string|null, ≤500
  // - `home_region`:  string|null, ≤120
  // - `preferences`:  partial object, shallow-merged onto the stored one
  // `@IsOptional` in class-validator treats `null` AND `undefined`
  // as "skip validation" — so nullable fields accept `null` to
  // clear, and a present non-null value must satisfy the rest. The
  // mock matches that semantics so a too-long or non-string value
  // surfaces the same 400 production would serve.
  app.patch("/api/v1/users/me", requireAuth, (req: AuthedRequest, res) => {
    const user = state.users.get(req.session!.user_id)!;
    const body = req.body ?? {};
    const violations: string[] = [];
    const validateString = (
      field: string,
      maxLength: number,
      nullable: boolean,
    ) => {
      if (!(field in body)) return;
      const value = body[field];
      if (nullable && value === null) return;
      if (typeof value !== "string" || value.length > maxLength) {
        violations.push(`${field} must be a string (≤${maxLength} chars)`);
      }
    };
    validateString("display_name", 100, false);
    validateString("phone", 20, false);
    validateString("avatar_url", 500, true);
    validateString("bio", 500, true);
    validateString("home_region", 120, true);
    if (violations.length > 0) {
      res.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: violations,
      });
      return;
    }
    if (body.display_name !== undefined) {
      user.display_name = body.display_name;
    }
    if (body.avatar_url !== undefined) {
      user.avatar_url = body.avatar_url;
    }
    if (body.bio !== undefined) {
      user.bio = body.bio;
    }
    if (body.home_region !== undefined) {
      user.home_region = body.home_region;
    }
    if (body.phone !== undefined) {
      user.phone = body.phone;
    }
    // Mirrors the real backend's updateProfile merge (post-fix): shallow
    // merge onto the stored object, skipping undefined-valued keys so a
    // partial patch (e.g. just `{ format_locale, timezone }`) never wipes
    // previously stored keys like `units`.
    if (body.preferences !== undefined) {
      const patch = Object.fromEntries(
        Object.entries(body.preferences ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      );
      user.preferences = { ...user.preferences, ...patch };
    }
    res.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      phone: user.phone,
      avatar_url: user.avatar_url,
      bio: user.bio,
      home_region: user.home_region,
      home_location: null,
      work_location: null,
      preferences: user.preferences,
      created_at: user.created_at,
    });
  });

  app.get(
    "/api/v1/users/:userId/profile",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const target = state.users.get(param(req, "userId"));
      // Production `getPublicProfile` 404s on both missing and
      // soft-deleted users so the response can't disambiguate the two.
      if (!target || state.deletedUsers.has(target.id)) {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      const isSelf = target.id === session.user_id;
      // #279 — `private` profiles 404 to non-self viewers.
      const targetPrivacy = state.privacy.get(target.id);
      if (!isSelf && targetPrivacy?.profile_visibility === "private") {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      // Counts derive from `state.userFollows`: follower_count is the
      // number of viewers who have followed `target.id`, following_count
      // is how many users `target.id` has followed.
      let followerCount = 0;
      for (const follows of state.userFollows.values()) {
        if (follows.has(target.id)) followerCount += 1;
      }
      const followingMap = state.userFollows.get(target.id);
      const followingCount = followingMap ? followingMap.size : 0;
      // `is_following` is null when viewing yourself so the page hides
      // the follow CTA instead of defaulting it to "Follow".
      const viewerFollowsTarget = isSelf
        ? null
        : (state.userFollows.get(session.user_id)?.has(target.id) ?? false);
      // Reverse edge (target → viewer) for the "Follows you" badge; null for
      // self, mirroring `is_following`.
      const targetFollowsViewer = isSelf
        ? null
        : (state.userFollows.get(target.id)?.has(session.user_id) ?? false);
      // Lifetime distance over the rider's completed rides (Distance tile).
      let totalDistanceKm = 0;
      for (const ride of state.rides.values()) {
        if (ride.user_id === target.id && ride.status === "completed") {
          totalDistanceKm += ride.distance_km;
        }
      }
      // Public-share count (Rides shared tile), viewer-independent.
      let sharedRideCount = 0;
      for (const share of state.rideShares.values()) {
        if (!share.is_public) continue;
        const ride = state.rides.get(share.ride_id);
        if (ride?.user_id === target.id) sharedRideCount += 1;
      }
      res.json({
        id: target.id,
        display_name: target.display_name,
        avatar_url: target.avatar_url,
        bio: target.bio,
        home_region: target.home_region,
        created_at: target.created_at,
        follower_count: followerCount,
        following_count: followingCount,
        total_distance_km: Math.round(totalDistanceKm),
        shared_ride_count: sharedRideCount,
        is_following: viewerFollowsTarget,
        follows_you: targetFollowsViewer,
        is_self: isSelf,
      });
    },
  );

  // Production `BadgesService.listBadges` always returns the full
  // 7-entry catalogue with `tier: null` + `earned_at: null` for
  // badges the rider hasn't earned yet — the profile page branches
  // between "No badges available yet" (catalogue empty) and "No
  // badges earned yet" (catalogue non-empty, nothing earned), so
  // an empty array on the mock would let an e2e assert the wrong
  // empty state. Keep the catalogue in sync with
  // `apps/backend/src/modules/badges/badge-definitions.ts`.
  app.get(
    "/api/v1/users/:userId/badges",
    requireAuth,
    (req: AuthedRequest, res) => {
      const target = state.users.get(param(req, "userId"));
      if (!target || state.deletedUsers.has(target.id)) {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      res.json(MOCK_BADGE_CATALOGUE);
    },
  );

  // Rider XP / level / tier for the achievements hero. Production derives XP
  // from many lifetime stats; the mock uses the dominant terms it tracks
  // (completed-ride distance + ride count) with the same level curve and tier
  // bands as `progression-definitions.ts`, so the hero renders deterministic
  // tier/level/progress in e2e.
  app.get(
    "/api/v1/users/me/progression",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      let totalDistanceKm = 0;
      let rideCount = 0;
      for (const ride of state.rides.values()) {
        if (ride.user_id === session.user_id && ride.status === "completed") {
          totalDistanceKm += ride.distance_km;
          rideCount += 1;
        }
      }
      const xp = Math.round(totalDistanceKm + rideCount * 50);
      const xpForLevel = (lvl: number) =>
        lvl <= 1 ? 0 : 125 * (lvl - 1) * lvl;
      const level =
        xp < 250 ? 1 : Math.floor((1 + Math.sqrt(1 + (4 * xp) / 125)) / 2);
      const tiers = [
        { name: "Rookie Rider", minLevel: 1 },
        { name: "Road Tripper", minLevel: 5 },
        { name: "Curve Hunter", minLevel: 10 },
        { name: "Mountain Goat", minLevel: 15 },
        { name: "Pass Master", minLevel: 20 },
        { name: "Tarmac Legend", minLevel: 25 },
      ];
      let idx = 0;
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        if (tier && level >= tier.minLevel) idx = i;
      }
      const current = tiers[idx];
      if (!current) throw new Error("tier index out of range");
      const next = tiers[idx + 1] ?? null;
      const nextTierXp = next ? xpForLevel(next.minLevel) : null;
      res.json({
        xp,
        level,
        tier: current.name,
        next_tier: next?.name ?? null,
        current_tier_xp: xpForLevel(current.minLevel),
        next_tier_xp: nextTierXp,
        xp_to_next_tier: nextTierXp != null ? Math.max(0, nextTierXp - xp) : 0,
      });
    },
  );

  // Paginated list of the rider's shared rides. Non-self viewers only
  // see public shares; the rider viewing their own profile sees both
  // public and private shares (production `SharingService.listForUser`
  // — issue #279). Mock filters `state.rideShares` against the
  // rider's `ride.user_id` and `is_public` flag.
  app.get(
    "/api/v1/users/:userId/shared-rides",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const target = state.users.get(param(req, "userId"));
      if (!target || state.deletedUsers.has(target.id)) {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      const isSelf = target.id === session.user_id;
      const targetPrivacy = state.privacy.get(target.id);
      if (!isSelf && targetPrivacy?.profile_visibility === "private") {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      const limit = Math.max(0, Number(req.query.limit ?? 20));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      const shares: Array<{
        token: string;
        ride: import("./state").MockRide;
        is_public: boolean;
      }> = [];
      for (const [token, share] of state.rideShares) {
        if (!isSelf && !share.is_public) continue;
        const ride = state.rides.get(share.ride_id);
        if (!ride || ride.user_id !== target.id) continue;
        shares.push({ token, ride, is_public: share.is_public });
      }
      // `SharingService.listForUser` orders by `share.created_at DESC`
      // (the share row, not the ride). The mock doesn't track a
      // separate `shared_at` per row, so reuse the ride's
      // `started_at` as the proxy — collapses ties deterministically
      // and matches the newest-first display the page expects.
      shares.sort((a, b) => b.ride.started_at.localeCompare(a.ride.started_at));
      const page = shares
        .slice(offset, offset + limit)
        .map(({ token, ride, is_public }) => ({
          id: ride.id,
          share_token: token,
          name: ride.name,
          ride_type: ride.ride_type,
          is_public,
          started_at: ride.started_at,
          ended_at: ride.ended_at,
          distance_km: ride.distance_km,
          avg_speed: ride.avg_speed,
          avg_road_quality: ride.avg_road_quality,
          avg_curviness: ride.avg_curviness,
          duration_min: deriveDurationMin(ride),
          view_count: state.rideShares.get(token)?.view_count ?? 0,
          shared_at: ride.started_at,
          route_geometry: ride.route_geometry,
        }));
      // Views are summed across the whole visible set, not just the page —
      // matching the backend aggregate that drives the "total views" figure.
      const totalViews = shares.reduce(
        (sum, { token }) =>
          sum + (state.rideShares.get(token)?.view_count ?? 0),
        0,
      );
      res.json({
        items: page,
        total: shares.length,
        total_views: totalViews,
        limit,
        offset,
      });
    },
  );

  app.post(
    "/api/v1/users/:userId/follow",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const target = state.users.get(param(req, "userId"));
      if (!target || state.deletedUsers.has(target.id)) {
        res.status(404).json({ message: "user-not-found" });
        return;
      }
      if (target.id === session.user_id) {
        res.status(400).json({ message: "cannot-follow-self" });
        return;
      }
      let follows = state.userFollows.get(session.user_id);
      if (!follows) {
        follows = new Map();
        state.userFollows.set(session.user_id, follows);
      }
      // `user_follows` carries a UNIQUE (follower, following) index —
      // production maps the constraint violation to a 409 rather than
      // returning 200 for a duplicate. Mirror that so a re-follow
      // surfaces the same status the companion's `followRider` swallows.
      if (follows.has(target.id)) {
        res.status(409).json({ message: "already-following" });
        return;
      }
      const followedAt = new Date().toISOString();
      follows.set(target.id, followedAt);
      // Match `FollowUserResponseDto` (`following_id`, `display_name`,
      // `followed_at`) — the production handler returns the target's
      // display name on success so the companion can render a richer
      // toast without a second round-trip. The legacy `follower_id` /
      // `created_at` shape was mock-only and would let a client that
      // started reading these fields drift away from the real wire.
      res.status(201).json({
        following_id: target.id,
        display_name: target.display_name,
        followed_at: followedAt,
      });
    },
  );

  app.delete(
    "/api/v1/users/:userId/follow",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const target = state.users.get(param(req, "userId"));
      if (!target) {
        res.status(404).json({ message: "not-following-this-user" });
        return;
      }
      const follows = state.userFollows.get(session.user_id);
      if (!follows?.has(target.id)) {
        res.status(404).json({ message: "not-following-this-user" });
        return;
      }
      follows.delete(target.id);
      res.status(204).end();
    },
  );

  // ── Rides ────────────────────────────────────────────────────────
  // Three endpoints back the rides surface: list (paginated + filtered),
  // tracks (geometry only, same filters minus sort/page — used for the
  // map overlay), and detail. All three filter by `user_id === session`
  // so a seeded ride only shows up for the rider who owns it.
  app.get("/api/v1/rides", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const filtered = filterRides(req, session.user_id);
    const sort = String(req.query.sort ?? "started_at");
    const order = String(req.query.order ?? "desc") === "asc" ? 1 : -1;
    // `duration_min` is a derived value — read it through the same
    // `deriveDurationMin` helper the serializers use so sort + display
    // stay consistent. Other fields read straight off the row.
    const valueFor = (ride: import("./state").MockRide): unknown => {
      if (sort === "duration_min") return deriveDurationMin(ride);
      return (ride as unknown as Record<string, unknown>)[sort];
    };
    const sorted = filtered.slice().sort((a, b) => {
      const va = valueFor(a);
      const vb = valueFor(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * order;
      }
      return String(va ?? "").localeCompare(String(vb ?? "")) * order;
    });
    const limit = Math.max(0, Number(req.query.limit ?? 20));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const page = sorted.slice(offset, offset + limit);
    res.json({
      rides: page.map(serializeRideSummary),
      total: sorted.length,
    });
  });

  app.get("/api/v1/rides/tracks", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    // `RidesService.getTracks` filters `route_geom IS NOT NULL` first,
    // then orders by `started_at DESC`, then caps at 500. The mock has
    // to apply the same order so a test seeding many no-GPS rides plus
    // one older route-bearing ride doesn't see the route get dropped
    // by the cap (which would falsely flip `truncated` to true while
    // production happily returns the route).
    const MAX = 500;
    const filtered = filterRides(req, session.user_id).filter(
      (ride) => ride.route_geometry.length >= 2,
    );
    const ordered = filtered
      .slice()
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    const truncated = ordered.length > MAX;
    const visible = ordered.slice(0, MAX);
    res.json({
      tracks: visible.map((ride) => ({
        id: ride.id,
        geometry: {
          type: "LineString" as const,
          coordinates: ride.route_geometry.map(
            (p) => [p.lng, p.lat] as [number, number],
          ),
        },
      })),
      truncated,
    });
  });

  // Surface + curviness breakdown. The real backend derives this from the
  // rides' snapped `ride_segments → road_segments`; the mock returns a
  // deterministic non-empty sample (or an empty breakdown when the filter
  // matches no rides) so the stats cards exercise both render branches.
  // Registered before `:rideId` so "stats" isn't captured as a rideId.
  app.get(
    "/api/v1/rides/stats/breakdown",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const rides = filterRides(req, session.user_id);
      if (rides.length === 0) {
        res.json({ surface: [], curviness: [], total_meters: 0 });
        return;
      }
      const slice = (key: string, pct: number) => ({
        key,
        meters: pct * 1000,
        pct,
      });
      res.json({
        surface: [
          slice("asphalt", 78),
          slice("concrete", 8),
          slice("cobblestone", 5),
          slice("gravel", 7),
          slice("dirt", 2),
        ],
        curviness: [
          slice("straight", 12),
          slice("flowing", 28),
          slice("twisty", 36),
          slice("tight", 18),
          slice("hairpin", 6),
        ],
        total_meters: 100000,
      });
    },
  );

  // Public shared-ride view — anonymous access, no auth middleware.
  // Must register BEFORE `/api/v1/rides/:rideId` so the "shared"
  // segment isn't captured as a rideId.
  app.get("/api/v1/rides/shared/:token", (req, res) => {
    const share = state.rideShares.get(param(req, "token"));
    const ride = share ? state.rides.get(share.ride_id) : null;
    if (!share || !ride) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    // Production increments the view counter on every fetch — mirror
    // so subsequent `view_count` reads through the same token reflect
    // accumulating views.
    share.view_count += 1;
    const owner = state.users.get(ride.user_id);
    res.json({
      id: ride.id,
      rider_name: owner?.display_name ?? "Anonymous Rider",
      ride_type: ride.ride_type,
      started_at: ride.started_at,
      ended_at: ride.ended_at,
      distance_km: ride.distance_km,
      avg_speed: ride.avg_speed,
      max_speed: ride.max_speed,
      avg_road_quality: ride.avg_road_quality,
      avg_curviness: ride.avg_curviness,
      duration_min: deriveDurationMin(ride),
      view_count: share.view_count,
      route_geometry: ride.route_geometry,
    });
  });

  app.get("/api/v1/rides/:rideId", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const ride = state.rides.get(param(req, "rideId"));
    if (!ride) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    // Resolve the ride's share (one per ride). `rideShares` is keyed by token,
    // so the entry's key *is* the share token. The owner gets it regardless of
    // is_public; a non-owner is gated on is_public.
    const shareEntry = [...state.rideShares.entries()].find(
      ([, s]) => s.ride_id === ride.id,
    );
    if (ride.user_id !== session.user_id) {
      // Non-owners may view a ride only when its owner publicly shared it and
      // isn't private — mirrors the relaxed backend + community-feed gate.
      const ownerPrivate =
        state.privacy.get(ride.user_id)?.profile_visibility === "private";
      if (!shareEntry?.[1].is_public || ownerPrivate) {
        res.status(404).json({ message: "not-found" });
        return;
      }
    }
    const owner = state.users.get(ride.user_id);
    res.json(
      serializeRideDetail(
        ride,
        session.user_id,
        owner,
        shareEntry?.[0] ?? null,
      ),
    );
  });

  // Export: `downloadRideExport` calls `/api/v1/rides/:rideId/csv` or
  // `/api/v1/rides/:rideId/gpx` and consumes the response as a blob.
  // Return a tiny representative body with the correct Content-Type /
  // Content-Disposition so the test can confirm a download fired
  // without having to validate file contents byte-for-byte. Express 5
  // dropped inline-regex route params (`:format(csv|gpx)`), so the
  // two formats are registered separately and share a helper.
  const sendRideExport = (
    req: AuthedRequest,
    res: Response,
    format: "csv" | "gpx",
  ) => {
    const session = req.session!;
    const ride = state.rides.get(param(req, "rideId"));
    if (!ride || ride.user_id !== session.user_id) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    const filename = `tarmoto-ride-${ride.id}.${format}`;
    res.setHeader(
      "Content-Type",
      format === "csv" ? "text/csv" : "application/gpx+xml",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "csv") {
      res.send(
        `started_at,distance_km,duration_min\n${ride.started_at},${ride.distance_km},${deriveDurationMin(ride) ?? ""}\n`,
      );
    } else {
      res.send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"><trk><name>${ride.name ?? ride.id}</name></trk></gpx>\n`,
      );
    }
  };
  app.get("/api/v1/rides/:rideId/csv", requireAuth, (req: AuthedRequest, res) =>
    sendRideExport(req, res, "csv"),
  );
  app.get("/api/v1/rides/:rideId/gpx", requireAuth, (req: AuthedRequest, res) =>
    sendRideExport(req, res, "gpx"),
  );

  // Catch-all for unhandled routes — return 200 with an empty body so a
  // page that fires off a non-critical fetch (e.g. for a feature we
  // haven't mocked) doesn't block the test on a JSON parse error.
  app.use((req, res) => {
    res.status(404).json({
      message: `mock-backend: no handler for ${req.method} ${req.path}`,
    });
  });

  return app;
}

function serializeTripCard(trip: import("./state").MockTrip) {
  // Mirrors production `TripSummaryDto` (`apps/backend/src/modules
  // /trips/dto/trip-response.dto.ts::TripSummaryDto`): list rows
  // carry `title` + `created_at` (snake_case wire shape), NOT the
  // companion's camelCase `name` + `createdAt`. The companion's
  // `tripSummaryFromWire` adapter handles the translation. Previous
  // versions of this mock returned a richer detail-like payload
  // which let e2e tests pass against fields production never serves.
  return {
    id: trip.id,
    owner_id: trip.owner_id,
    title: trip.title,
    region: null,
    num_days: trip.num_days,
    status: trip.status,
    member_count: trip.members.length,
    folder_id: trip.folder_id ?? null,
    created_at: trip.created_at,
  };
}

function serializeTripDetail(trip: import("./state").MockTrip) {
  const members = trip.members.map((userId) => {
    const user = state.users.get(userId);
    return {
      user_id: userId,
      display_name: user?.display_name ?? "Unknown",
      // Non-owner test members are editors (matches the /members roster
      // above and the real backend, which renamed the legacy `member`
      // role to `editor`).
      role: userId === trip.owner_id ? "owner" : "editor",
      joined_at: trip.created_at,
    };
  });
  return {
    id: trip.id,
    title: trip.title,
    region: null,
    num_days: trip.num_days,
    status: trip.status,
    member_count: members.length,
    created_at: trip.created_at,
    daily_km_min: trip.daily_km_min ?? 200,
    daily_km_max: trip.daily_km_max ?? 300,
    min_quality: trip.min_quality ?? 3,
    road_preference: trip.road_preference ?? "mixed",
    invite_code: trip.id.slice(0, 8),
    members,
    days: serializedTripDays(trip),
    // TripDetailDto extends TripSummaryDto on the backend — surface
    // these so list-side consumers of the adapter (folder-scoped
    // views, owner-aware UI) round-trip correctly.
    owner_id: trip.owner_id,
    folder_id: trip.folder_id ?? null,
  };
}

function serializedTripDays(trip: import("./state").MockTrip) {
  const days = trip.snapshot.days;
  return Array.isArray(days) ? days : [];
}

function buildGeneratedOption(
  id: string,
  selected: string,
  numDays: number,
  dailyTarget: number,
  body: Record<string, unknown> | undefined,
) {
  const labels: Record<string, string> = {
    "best-fit": "Best fit",
    scenic: "Scenic sweep",
    fastest: "Fastest line",
  };
  const summaries: Record<string, string> = {
    "best-fit": "Balanced route closest to your trip settings.",
    scenic: "More mountain roads and viewpoints.",
    fastest: "Lower transfer time while keeping good roads.",
  };
  const multiplier = id === "scenic" ? 1.12 : id === "fastest" ? 0.88 : 1;
  const days = Array.from({ length: Math.max(1, numDays) }, (_, index) =>
    buildGeneratedDay(index + 1, id, dailyTarget, multiplier, body),
  );
  return {
    id,
    label: labels[id] ?? id,
    summary: summaries[id] ?? "Generated route option.",
    total_distance_km: days.reduce((sum, day) => sum + day.distance_km, 0),
    total_duration_min: days.reduce(
      (sum, day) => sum + day.estimated_time_min,
      0,
    ),
    avg_quality:
      days.reduce((sum, day) => sum + day.avg_quality, 0) / days.length,
    avg_curviness:
      days.reduce((sum, day) => sum + day.curviness_score, 0) / days.length,
    avg_scenic:
      days.reduce((sum, day) => sum + day.scenic_score, 0) / days.length,
    selected: id === selected,
    days,
  };
}

function buildGeneratedDay(
  dayNumber: number,
  optionId: string,
  dailyTarget: number,
  multiplier: number,
  body: Record<string, unknown> | undefined,
) {
  const start =
    typeof body?.start_location === "object" && body.start_location !== null
      ? (body.start_location as { lat?: number; lng?: number })
      : { lat: 46.47, lng: 10.37 };
  const lat = Number(start.lat ?? 46.47) + (dayNumber - 1) * 0.12;
  const lng = Number(start.lng ?? 10.37) + (dayNumber - 1) * 0.18;
  const bend =
    optionId === "scenic" ? 0.16 : optionId === "fastest" ? 0.05 : 0.1;
  const geometry = [
    { lat, lng },
    { lat: lat + bend, lng: lng + 0.18 },
    { lat: lat + 0.24, lng: lng + 0.34 },
  ];
  const distance = Math.round(dailyTarget * multiplier);
  return {
    id: `mock-day-${optionId}-${dayNumber}`,
    day_number: dayNumber,
    title: `Day ${dayNumber} ${optionId}`,
    distance_km: distance,
    avg_quality:
      optionId === "fastest" ? 3.8 : optionId === "scenic" ? 4.6 : 4.2,
    elevation_gain: Math.round(distance * (optionId === "scenic" ? 9 : 6)),
    elevation_loss: Math.round(distance * 4),
    curviness_score:
      optionId === "fastest" ? 58 : optionId === "scenic" ? 88 : 74,
    scenic_score: optionId === "fastest" ? 62 : optionId === "scenic" ? 92 : 80,
    estimated_time_min: Math.round(
      distance * (optionId === "fastest" ? 1.0 : 1.2),
    ),
    route_geometry: geometry,
    waypoints: [
      {
        id: `mock-wp-${optionId}-${dayNumber}-start`,
        sequence: 0,
        lat: geometry[0]!.lat,
        lng: geometry[0]!.lng,
        name: dayNumber === 1 ? "Start" : `Day ${dayNumber} start`,
        waypoint_type: "start",
        road_segment_id: null,
        notes: null,
        duration_min: null,
      },
      {
        id: `mock-wp-${optionId}-${dayNumber}-end`,
        sequence: 1,
        lat: geometry.at(-1)!.lat,
        lng: geometry.at(-1)!.lng,
        name: `Day ${dayNumber} finish`,
        waypoint_type: "end",
        road_segment_id: null,
        notes: null,
        duration_min: null,
      },
    ],
  };
}

function serializeSuggestion(
  s: import("./state").MockSuggestion,
  callerId: string,
) {
  return {
    id: s.id,
    trip_id: s.trip_id,
    trip_day_id: s.trip_day_id,
    suggested_by: s.suggested_by,
    suggester_display_name: s.suggester_display_name,
    road_segment_id: s.road_segment_id,
    title: s.title,
    description: s.description,
    lat: s.lat,
    lng: s.lng,
    status: s.status,
    up_votes: s.up_votes,
    down_votes: s.down_votes,
    caller_vote: s.votes[callerId] ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function pushActivity(
  tripId: string,
  actorId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  const actor = state.users.get(actorId);
  state.activity.push({
    id: randomUUID(),
    trip_id: tripId,
    actor_id: actorId,
    actor_name: actor?.display_name ?? null,
    action,
    payload,
    created_at: new Date().toISOString(),
  });
}

type LatLng = { lat: number; lng: number };

// Distance in km from point `p` to the nearest point on segment AB,
// where "segment" means the geodesic between two WGS84 vertices.
// `ST_DWithin` on a LineString geography measures perpendicular
// distance to the line itself, not its vertices — a test point
// near the middle of a long leg can be inside `radius_m` of the line
// while being far from every vertex. We approximate that with a
// local equirectangular projection at the segment's mean latitude,
// which is faithful to a few centimetres at the kilometre scale
// these tests care about and avoids dragging in a full geography
// library.
function kmToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const meanLat = (a.lat + b.lat) / 2;
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos(toRad(meanLat));
  const ax = a.lng * kmPerDegLng;
  const ay = a.lat * kmPerDegLat;
  const bx = b.lng * kmPerDegLng;
  const by = b.lat * kmPerDegLat;
  const px = p.lng * kmPerDegLng;
  const py = p.lat * kmPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // Degenerate "segment" of zero length collapses to point-to-point.
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Project lat/lng to local equirectangular kilometre coordinates
// at the supplied mean latitude. Shared by the segment helpers
// below so segment-vs-segment / segment-vs-rectangle math stays
// in a flat plane.
function toKm(p: LatLng, meanLat: number): { x: number; y: number } {
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos((meanLat * Math.PI) / 180);
  return { x: p.lng * kmPerDegLng, y: p.lat * kmPerDegLat };
}

// Standard 2D segment-segment intersection. Returns true when AB
// and CD touch or cross. Operates in the local projection — the
// approximation is faithful to a few centimetres at the kilometre
// scale these mocks operate on.
function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const meanLat = (a.lat + b.lat + c.lat + d.lat) / 4;
  const A = toKm(a, meanLat);
  const B = toKm(b, meanLat);
  const C = toKm(c, meanLat);
  const D = toKm(d, meanLat);
  const denom = (B.x - A.x) * (D.y - C.y) - (B.y - A.y) * (D.x - C.x);
  if (denom === 0) return false; // parallel or collinear (treat as no-cross)
  const t = ((C.x - A.x) * (D.y - C.y) - (C.y - A.y) * (D.x - C.x)) / denom;
  const s = ((C.x - A.x) * (B.y - A.y) - (C.y - A.y) * (B.x - A.x)) / denom;
  return t >= 0 && t <= 1 && s >= 0 && s <= 1;
}

// Min km distance between two line segments. Handles the crossing
// case (distance is 0) and the disjoint case via the four
// endpoint-to-segment distances — exact for any non-degenerate
// pair, no sampling required.
function kmSegmentToSegment(
  a: LatLng,
  b: LatLng,
  c: LatLng,
  d: LatLng,
): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    kmToSegment(a, c, d),
    kmToSegment(b, c, d),
    kmToSegment(c, a, b),
    kmToSegment(d, a, b),
  );
}

// Min km distance between two polylines. Min over every (segment,
// segment) pair — mirrors `ST_Distance(closure::geography,
// route::geography)`. The companion mock uses this for the
// `/closures/check-route` buffer check so closures running
// parallel to (or crossing) the route between vertices still
// register, unlike a vertex-only sample.
function polylinesMinKm(a: readonly LatLng[], b: readonly LatLng[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  if (a.length === 1 && b.length === 1) return kmToSegment(a[0]!, b[0]!, b[0]!);
  if (a.length === 1) return kmToPolyline(a[0]!, b);
  if (b.length === 1) return kmToPolyline(b[0]!, a);
  let min = Infinity;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const d = kmSegmentToSegment(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
      if (d < min) min = d;
      if (min === 0) return 0;
    }
  }
  return min;
}

// True iff the polyline intersects the lat/lng envelope. Used for
// bbox-filtering closures: a closure whose vertices are both
// outside the box but whose segment crosses through still matches
// (mirrors `ST_Intersects(c.geom, envelope)`).
function polylineIntersectsBbox(
  polyline: readonly LatLng[],
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
): boolean {
  if (polyline.length === 0) return false;
  // Any vertex inside the envelope is an immediate hit.
  for (const pt of polyline) {
    if (
      pt.lng >= minLng &&
      pt.lng <= maxLng &&
      pt.lat >= minLat &&
      pt.lat <= maxLat
    ) {
      return true;
    }
  }
  if (polyline.length === 1) return false;
  // No vertex inside — check each segment against the four edges
  // of the envelope. Any crossing counts.
  const corners: LatLng[] = [
    { lat: minLat, lng: minLng },
    { lat: minLat, lng: maxLng },
    { lat: maxLat, lng: maxLng },
    { lat: maxLat, lng: minLng },
  ];
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    for (let e = 0; e < 4; e++) {
      const c = corners[e]!;
      const d = corners[(e + 1) % 4]!;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

// Min distance from `p` to the polyline. Mirrors `ST_Distance(
// route_geom::geography, ST_MakePoint(...))` for the
// `ST_DWithin(...) <= radius_m` predicate.
function kmToPolyline(p: LatLng, polyline: readonly LatLng[]): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return kmToSegment(p, polyline[0]!, polyline[0]!);
  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = kmToSegment(p, polyline[i]!, polyline[i + 1]!);
    if (d < min) min = d;
  }
  return min;
}

function filterRides(
  req: Request,
  userId: string,
): import("./state").MockRide[] {
  const q = req.query;
  const startedFrom = q.started_from ? String(q.started_from) : null;
  const startedTo = q.started_to ? String(q.started_to) : null;
  const minDistance =
    q.min_distance_km != null ? Number(q.min_distance_km) : null;
  const maxDistance =
    q.max_distance_km != null ? Number(q.max_distance_km) : null;
  const minQuality = q.min_quality != null ? Number(q.min_quality) : null;
  const maxQuality = q.max_quality != null ? Number(q.max_quality) : null;
  const search = q.q ? String(q.q).toLowerCase() : null;
  const type = q.type ? String(q.type) : null;
  // `RidesService.applyRidesFilters` runs `ST_DWithin(route_geom, :pt,
  // :radius_m)` when all three params are present; the companion's
  // `useRidesQuery::toListParams` only ships the trio together, so
  // require the full set here too. Partial params silently drop the
  // proximity filter (matches production's all-or-nothing behaviour).
  const nearLat = q.near_lat != null ? Number(q.near_lat) : null;
  const nearLng = q.near_lng != null ? Number(q.near_lng) : null;
  const nearKm = q.near_km != null ? Number(q.near_km) : null;
  const nearActive =
    nearLat != null &&
    nearLng != null &&
    nearKm != null &&
    Number.isFinite(nearLat) &&
    Number.isFinite(nearLng) &&
    Number.isFinite(nearKm);
  return [...state.rides.values()].filter((ride) => {
    if (ride.user_id !== userId) return false;
    if (startedFrom && ride.started_at < startedFrom) return false;
    // Real backend treats `started_to` as inclusive end-of-day; mirror by
    // letting `YYYY-MM-DD` compare loosely against the ISO timestamp.
    if (startedTo && ride.started_at.slice(0, 10) > startedTo) return false;
    if (minDistance != null && ride.distance_km < minDistance) return false;
    if (maxDistance != null && ride.distance_km > maxDistance) return false;
    if (minQuality != null && ride.avg_road_quality < minQuality) return false;
    if (maxQuality != null && ride.avg_road_quality > maxQuality) return false;
    // Production filter only searches the user-set `name` column
    // (`RidesService.applyRidesFilters` uses `ride.name ILIKE :q`), and
    // the UI labels this field "Search name". Matching `ride_type` here
    // too would let an e2e search for a built-in type (e.g. "commute")
    // and pass against the mock while a real backend would return zero
    // rows — keep the mock honest.
    if (search && !(ride.name ?? "").toLowerCase().includes(search)) {
      return false;
    }
    if (type && ride.ride_type !== type) return false;
    if (nearActive) {
      // `ST_DWithin` against a NULL geometry is false; rides with no
      // route geometry can never satisfy a proximity filter.
      if (ride.route_geometry.length === 0) return false;
      const center = { lat: nearLat, lng: nearLng };
      if (kmToPolyline(center, ride.route_geometry) > nearKm) return false;
    }
    return true;
  });
}

/**
 * Production derives `duration_min` from `ended_at - started_at` (the
 * rides table has no stored duration column). Mirror that here so a
 * test seeding inconsistent timestamps + duration can't get a green
 * assertion against a value the real backend would never produce.
 * Returns null when the ride is still active (ended_at unset).
 */
function deriveDurationMin(ride: import("./state").MockRide): number | null {
  if (!ride.ended_at) return null;
  const diffMs =
    new Date(ride.ended_at).getTime() - new Date(ride.started_at).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  return Math.round(diffMs / 60_000);
}

function serializeRideSummary(ride: import("./state").MockRide) {
  return {
    id: ride.id,
    name: ride.name,
    started_at: ride.started_at,
    ended_at: ride.ended_at,
    ride_type: ride.ride_type,
    status: ride.status,
    distance_km: ride.distance_km,
    avg_speed: ride.avg_speed,
    avg_road_quality: ride.avg_road_quality,
    duration_min: deriveDurationMin(ride),
  };
}

function serializeRideDetail(
  ride: import("./state").MockRide,
  viewerId: string,
  owner: { display_name: string; avatar_url: string | null } | undefined,
  shareToken: string | null,
) {
  return {
    id: ride.id,
    // `name` is inherited from the summary contract (RideSummaryDto); the
    // detail header surfaces it (falling back to "Ride on <date>" when null).
    name: ride.name ?? null,
    status: ride.status,
    ride_type: ride.ride_type,
    started_at: ride.started_at,
    ended_at: ride.ended_at,
    distance_km: ride.distance_km,
    duration_min: deriveDurationMin(ride),
    avg_speed: ride.avg_speed,
    max_speed: ride.max_speed,
    avg_road_quality: ride.avg_road_quality,
    elevation_gain: ride.elevation_gain,
    elevation_loss: ride.elevation_loss,
    curve_count: ride.curve_count,
    max_lean_angle: ride.max_lean_angle,
    fuel_estimate_l: ride.fuel_estimate_l,
    route_geometry: ride.route_geometry,
    segments: ride.segments,
    viewer_is_owner: ride.user_id === viewerId,
    rider_id: ride.user_id,
    rider_name: owner?.display_name ?? "",
    rider_avatar_url: owner?.avatar_url ?? null,
    share_token: shareToken,
  };
}

interface CollectionSerializeOptions {
  /**
   * Suppresses `owner_name` when true. Production's
   * `RouteCollectionsService.toSummaryResponse` returns `null` for the
   * rider's own rows (the rider knows their own name) and populates
   * the field only on surfaces that show other riders' collections.
   */
  ownedByViewer?: boolean;
  /**
   * Masks BOTH `owner_id` and `owner_name` to `null`. Production
   * applies this when the owner's `profile_visibility` is private and
   * the viewer is not the owner themselves — see
   * `RouteCollectionsService.toSummaryResponse`'s private-owner
   * branch.
   */
  maskOwner?: boolean | undefined;
}

function serializeCollectionSummary(
  collection: import("./state").MockCollection,
  opts: CollectionSerializeOptions = {},
): {
  id: string;
  owner_id: string | null;
  title: string;
  description: string | null;
  visibility: string;
  slug: string;
  item_count: number;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
} {
  const owner = state.users.get(collection.owner_id);
  return {
    id: collection.id,
    owner_id: opts.maskOwner ? null : collection.owner_id,
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility,
    slug: collection.slug,
    item_count: 0,
    owner_name:
      opts.maskOwner || opts.ownedByViewer
        ? null
        : (owner?.display_name ?? "Anonymous Rider"),
    created_at: collection.created_at,
    updated_at: collection.updated_at,
  };
}

// `collectionFollows` is keyed user → {collectionId}, so a collection's
// follower count is the number of users whose set includes it. Production
// `toDetailResponse` counts follows for every detail endpoint, so all
// detail serializers go through this.
function countCollectionFollowers(
  collectionFollows: Map<string, Map<string, string>>,
  collectionId: string,
): number {
  let count = 0;
  for (const follows of collectionFollows.values()) {
    if (follows.has(collectionId)) count += 1;
  }
  return count;
}

function serializeCollectionDetail(
  collection: import("./state").MockCollection,
  viewerOwns: boolean,
  opts: {
    maskOwner?: boolean;
    viewerIsFollowing?: boolean;
    followerCount?: number;
  } = {},
) {
  // Production `RouteCollectionsService.toDetailResponse` hydrates the
  // owner relation and surfaces `owner_name` on every detail response
  // — the suppression only applies to summary/list responses for
  // owned rows. Forwarding `ownedByViewer: viewerOwns` here would let
  // an e2e assert `owner_name: null` on an owner-detail or self
  // public-slug payload that production never serves. Privacy still
  // wins via `maskOwner`.
  return {
    ...serializeCollectionSummary(collection, {
      maskOwner: opts.maskOwner,
    }),
    items: [] as unknown[],
    // Mirrors production `toDetailResponse`. Callers inside `buildApp` (where
    // `state` is in scope) pass the real count; defaults to 0 otherwise (e.g.
    // a freshly created collection).
    follower_count: opts.followerCount ?? 0,
    viewer_is_owner: viewerOwns,
    viewer_is_following: opts.viewerIsFollowing ?? false,
  };
}
