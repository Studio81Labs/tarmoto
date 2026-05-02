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

  app.post(
    "/api/v1/trips/:id/generate",
    requireAuth,
    (req: AuthedRequest, res) => {
      const trip = state.trips.get(param(req, "id"));
      if (!trip) {
        res.status(404).json({ message: "not-found" });
        return;
      }
      pushActivity(trip.id, req.session!.user_id, "trip_generated", {
        option: "best-fit",
      });
      res.json({ options: [] });
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
      trip_id: null,
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
      title: share.title,
      owner_name: "Test Owner",
      snapshot: share.snapshot,
      view_count: share.view_count,
      created_at: share.created_at,
      updated_at: share.updated_at,
    });
  });

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
    const { make, model, year, photoUrl, isActive } = req.body ?? {};
    const bike = {
      id: randomUUID(),
      make: String(make ?? ""),
      model: String(model ?? ""),
      year: Number(year ?? new Date().getFullYear()),
      photoUrl: photoUrl ?? null,
      isActive: list.length === 0 || Boolean(isActive),
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
        photoUrl: req.body?.photoUrl ?? bike.photoUrl,
      });
      if (req.body?.isActive === true) {
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
    days: [],
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
      dailyKmTarget: 250,
      roadPreference: "mixed",
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
    daily_km_min: 200,
    daily_km_max: 300,
    min_quality: 3,
    road_preference: "mixed",
    invite_code: trip.id.slice(0, 8),
    members,
    days: [],
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
