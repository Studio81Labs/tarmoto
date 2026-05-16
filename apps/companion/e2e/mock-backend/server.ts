import { randomUUID } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { state, type MockSession } from "./state";

interface AuthedRequest extends Request {
  session?: MockSession;
}

const MOCK_FUN_ZONE_ID = "11111111-2222-4333-8444-555555555000";
const MOCK_ROAD_SEGMENT_ID = "11111111-2222-4333-8444-555555555111";

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
  const planLabels: Record<string, { name: string; price: string }> = {
    free: { name: "Free", price: "€0" },
    premium: { name: "Premium", price: "€29.99/yr" },
    pro: { name: "Pro", price: "€49.99/yr" },
  };
  return {
    current_plan: {
      tier: sub.tier,
      name: planLabels[sub.tier].name,
      status: sub.status,
      price_label: planLabels[sub.tier].price,
      renews_at: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end,
      manage_url: null,
    },
    plans: [
      {
        tier: "free",
        name: "Free",
        price_label: "€0",
        features: ["Basic navigation", "Hazard alerts"],
      },
      {
        tier: "premium",
        name: "Premium",
        price_label: "€29.99/yr",
        highlighted: true,
        features: ["Unlimited trip planning", "Offline maps"],
      },
      {
        tier: "pro",
        name: "Pro",
        price_label: "€49.99/yr",
        features: ["Everything in Premium", "Priority alerts"],
      },
    ],
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
  // `/rides/shared/:token` can resolve to a seeded ride. Token defaults
  // to a generated one; tests can pin a known token for deterministic
  // URLs.
  app.post("/__test__/seed-ride-share", (req, res) => {
    const { ride_id, token } = req.body ?? {};
    if (!ride_id || !state.rides.has(ride_id)) {
      res.status(400).json({ message: "ride-not-found" });
      return;
    }
    const finalToken = String(token ?? randomUUID());
    state.rideShares.set(finalToken, ride_id);
    res.status(201).json({ token: finalToken });
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
      const wasActive = list[idx].isActive;
      list.splice(idx, 1);
      if (wasActive && list.length > 0) list[0].isActive = true;
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
      next[index] = {
        ...next[index],
        read_at: next[index].read_at ?? new Date().toISOString(),
      };
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
      res.json(client);
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

  // Endpoints the planner / explorer hit but don't strictly need real
  // data for E2E to pass.
  app.get("/api/v1/closures", (_req, res) => {
    res.json([]);
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
  // Default to an empty feed — the empty-state branch is what the page
  // ships today and what T37 asserts. Follow-up work can seed rides
  // here once the public-share flow is mocked end-to-end.
  app.get("/api/v1/rides/community", requireAuth, (_req, res) => {
    res.json({ items: [], total: 0, limit: 9, offset: 0 });
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
    // Production runs `OptionalAuthGuard` here: the bearer token is
    // read if present, and the viewer's identity feeds
    // `viewer_is_owner` / `viewer_is_following` so the page can render
    // the right CTA. Mirror that — fall back to anonymous if no token.
    const session = state.resolveSession(req.header("authorization"));
    const viewerOwns =
      session != null && session.user_id === collection.owner_id;
    res.json(serializeCollectionDetail(collection, viewerOwns));
  });

  app.get("/api/v1/collections/me", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const items = [...state.collections.values()]
      .filter((c) => c.owner_id === session.user_id)
      .map(serializeCollectionSummary);
    res.json({ items, total: items.length });
  });

  app.get(
    "/api/v1/collections/me/library",
    requireAuth,
    (req: AuthedRequest, res) => {
      const session = req.session!;
      const owned = [...state.collections.values()]
        .filter((c) => c.owner_id === session.user_id)
        .map(serializeCollectionSummary);
      res.json({ owned, followed: [] });
    },
  );

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
    res.json(serializeCollectionDetail(collection, /* viewerOwns */ true));
  });

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

  // Public shared-ride view — anonymous access, no auth middleware.
  // Must register BEFORE `/api/v1/rides/:rideId` so the "shared"
  // segment isn't captured as a rideId.
  app.get("/api/v1/rides/shared/:token", (req, res) => {
    const rideId = state.rideShares.get(param(req, "token"));
    const ride = rideId ? state.rides.get(rideId) : null;
    if (!ride) {
      res.status(404).json({ message: "not-found" });
      return;
    }
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
      avg_curviness: null,
      duration_min: deriveDurationMin(ride),
      view_count: 1,
      embed_click_count: 0,
      route_geometry: ride.route_geometry,
    });
  });

  app.get("/api/v1/rides/:rideId", requireAuth, (req: AuthedRequest, res) => {
    const session = req.session!;
    const ride = state.rides.get(param(req, "rideId"));
    if (!ride || ride.user_id !== session.user_id) {
      res.status(404).json({ message: "not-found" });
      return;
    }
    res.json(serializeRideDetail(ride));
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
  return {
    id: trip.id,
    name: trip.title,
    status: trip.status,
    days: serializedTripDays(trip),
    collaborators: trip.members.map((userId) => {
      const user = state.users.get(userId);
      return {
        userId,
        displayName: user?.display_name ?? "Unknown",
        role: userId === trip.owner_id ? "owner" : "viewer",
      };
    }),
    parameters: {
      days: trip.num_days,
      dailyKmTarget: Math.round(
        ((trip.daily_km_min ?? 200) + (trip.daily_km_max ?? 300)) / 2,
      ),
      roadPreference: trip.road_preference === "fast" ? "direct" : "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    createdAt: trip.created_at,
    updatedAt: trip.updated_at,
    folderId: null,
  };
}

function serializeTripDetail(trip: import("./state").MockTrip) {
  const members = trip.members.map((userId) => {
    const user = state.users.get(userId);
    return {
      user_id: userId,
      display_name: user?.display_name ?? "Unknown",
      role: userId === trip.owner_id ? "owner" : "member",
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

function serializeRideDetail(ride: import("./state").MockRide) {
  return {
    id: ride.id,
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
  };
}

function serializeCollectionSummary(
  collection: import("./state").MockCollection,
) {
  const owner = state.users.get(collection.owner_id);
  return {
    id: collection.id,
    owner_id: collection.owner_id,
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility,
    slug: collection.slug,
    item_count: 0,
    // /collections/me suppresses owner_name (rider knows their own
    // name); other surfaces echo it. The serializer always returns
    // the display name and lets each endpoint null it out if needed.
    owner_name: owner?.display_name ?? "Anonymous Rider",
    created_at: collection.created_at,
    updated_at: collection.updated_at,
  };
}

function serializeCollectionDetail(
  collection: import("./state").MockCollection,
  viewerOwns: boolean,
) {
  return {
    ...serializeCollectionSummary(collection),
    items: [],
    viewer_is_owner: viewerOwns,
    viewer_is_following: false,
  };
}
