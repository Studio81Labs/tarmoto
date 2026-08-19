import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const MOCK_BACKEND_PORT = Number(
  process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311,
);
const MOCK_BACKEND_URL = `http://127.0.0.1:${MOCK_BACKEND_PORT}`;

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
}

interface SeedOpts {
  email?: string;
  password?: string;
  displayName?: string;
}

export interface SeedRideOpts {
  id?: string;
  name?: string | null;
  ride_type?: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  distance_km?: number;
  duration_min?: number;
  avg_speed?: number;
  max_speed?: number;
  avg_road_quality?: number;
  avg_curviness?: number | null;
  elevation_gain?: number;
  elevation_loss?: number;
  curve_count?: number;
  max_lean_angle?: number;
  fuel_estimate_l?: number;
  route_geometry?: Array<{ lat: number; lng: number }>;
  segments?: Array<{
    road_name?: string | null;
    quality_reading?: number | null;
    speed_avg?: number | null;
    speed_max?: number | null;
    lean_angle_max?: number | null;
  }>;
}

export interface MockApi {
  reset(): Promise<void>;
  seedUser(opts?: SeedOpts): Promise<SeededUser>;
  setSubscription(
    userId: string,
    tier: "free" | "premium" | "pro",
  ): Promise<void>;
  addTripMember(tripId: string, userId: string): Promise<void>;
  /** Seed a follow edge so `followerId` follows `followingId`. */
  seedFollow(followerId: string, followingId: string): Promise<void>;
  createTrip(
    user: SeededUser,
    payload: { title: string; num_days?: number },
  ): Promise<{ id: string; title: string }>;
  seedRide(user: SeededUser, ride?: SeedRideOpts): Promise<{ id: string }>;
  seedRideShare(
    rideId: string,
    opts?: { token?: string; is_public?: boolean },
  ): Promise<{ token: string }>;
  seedCollection(
    user: SeededUser,
    opts?: {
      id?: string;
      title?: string;
      description?: string | null;
      visibility?: "private" | "unlisted" | "public";
      slug?: string;
    },
  ): Promise<{ id: string; slug: string }>;
  seedClosure(opts?: {
    id?: string;
    title?: string;
    severity?: "advisory" | "partial" | "full";
    reason?:
      "closure" | "roadworks" | "seasonal" | "weather" | "event" | "other";
  }): Promise<{ id: string }>;
  /**
   * Seed a trip that already has a routed day-1 geometry so the planner
   * opens it via `?tripId=` without firing live routing (dirty-gate:
   * existing geometry suppresses the routing hook until an edit).
   *
   * Pass `days` to seed a multi-day trip instead of the legacy
   * single-day `route_geometry` / `waypoints` shorthand.
   */
  seedTrip(
    user: SeededUser,
    opts?: {
      id?: string;
      title?: string;
      route_geometry?: Array<{ lat: number; lng: number }>;
      waypoints?: Array<{
        lat: number;
        lng: number;
        name?: string | null;
        type?: string;
      }>;
      distance_km?: number;
      days?: Array<{
        route_geometry?: Array<{ lat: number; lng: number }>;
        waypoints?: Array<{
          lat: number;
          lng: number;
          name?: string | null;
          type?: string;
        }>;
        start_linked?: boolean;
        distance_km?: number;
      }>;
    },
  ): Promise<{ id: string; title: string }>;
}

function buildMockApi(api: APIRequestContext): MockApi {
  return {
    async reset() {
      await api.post(`${MOCK_BACKEND_URL}/__test__/reset`);
    },
    async seedUser(opts: SeedOpts = {}) {
      const suffix = Math.random().toString(36).slice(2, 8);
      const payload = {
        email: opts.email ?? `rider-${suffix}@example.com`,
        password: opts.password ?? "TestPass123!",
        display_name: opts.displayName ?? `Rider ${suffix}`,
      };
      const res = await api.post(`${MOCK_BACKEND_URL}/__test__/seed-user`, {
        data: payload,
      });
      if (!res.ok()) {
        throw new Error(
          `seed-user failed: ${res.status()} ${await res.text()}`,
        );
      }
      const body = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        user: { id: string; email: string; display_name: string };
      };
      return {
        id: body.user.id,
        email: body.user.email,
        password: payload.password,
        displayName: body.user.display_name,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
      };
    },
    async seedFollow(followerId, followingId) {
      const res = await api.post(`${MOCK_BACKEND_URL}/__test__/seed-follow`, {
        data: { follower_id: followerId, following_id: followingId },
      });
      if (!res.ok()) {
        throw new Error(
          `seed-follow failed: ${res.status()} ${await res.text()}`,
        );
      }
    },
    async setSubscription(userId, tier) {
      await api.post(`${MOCK_BACKEND_URL}/__test__/set-subscription`, {
        data: { user_id: userId, tier },
      });
    },
    async addTripMember(tripId, userId) {
      const res = await api.post(
        `${MOCK_BACKEND_URL}/__test__/add-trip-member`,
        { data: { trip_id: tripId, user_id: userId } },
      );
      if (!res.ok()) {
        throw new Error(`add-trip-member failed: ${res.status()}`);
      }
    },
    async createTrip(user, payload) {
      const res = await api.post(`${MOCK_BACKEND_URL}/api/v1/trips`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
        data: payload,
      });
      if (!res.ok()) {
        throw new Error(`createTrip failed: ${res.status()}`);
      }
      return (await res.json()) as { id: string; title: string };
    },
    async seedRide(user, ride = {}) {
      const res = await api.post(`${MOCK_BACKEND_URL}/__test__/seed-ride`, {
        data: { user_id: user.id, ride },
      });
      if (!res.ok()) {
        throw new Error(`seedRide failed: ${res.status()} ${await res.text()}`);
      }
      return (await res.json()) as { id: string };
    },
    async seedRideShare(rideId, opts = {}) {
      const res = await api.post(
        `${MOCK_BACKEND_URL}/__test__/seed-ride-share`,
        {
          data: {
            ride_id: rideId,
            token: opts.token,
            is_public: opts.is_public,
          },
        },
      );
      if (!res.ok()) {
        throw new Error(
          `seedRideShare failed: ${res.status()} ${await res.text()}`,
        );
      }
      return (await res.json()) as { token: string };
    },
    async seedCollection(user, opts = {}) {
      const res = await api.post(
        `${MOCK_BACKEND_URL}/__test__/seed-collection`,
        { data: { owner_id: user.id, collection: opts } },
      );
      if (!res.ok()) {
        throw new Error(
          `seedCollection failed: ${res.status()} ${await res.text()}`,
        );
      }
      return (await res.json()) as { id: string; slug: string };
    },
    async seedClosure(opts = {}) {
      const res = await api.post(`${MOCK_BACKEND_URL}/__test__/seed-closure`, {
        data: { closure: opts },
      });
      if (!res.ok()) {
        throw new Error(
          `seedClosure failed: ${res.status()} ${await res.text()}`,
        );
      }
      return (await res.json()) as { id: string };
    },
    async seedTrip(user, opts = {}) {
      // Default route geometry: two well-separated points spanning the
      // same region as the demo-trip so closure + passes tests work.
      const defaultGeometry = [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.55, lng: 10.45 },
        { lat: 46.63, lng: 10.52 },
      ];
      const defaultWaypoints = [
        { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
        { lat: 46.63, lng: 10.52, name: "Finish", type: "end" },
      ];
      // Multi-day path: pass `days` directly to the seed endpoint.
      const data: Record<string, unknown> = {
        id: opts.id,
        title: opts.title ?? "Seeded route",
      };
      if (opts.days) {
        data.days = opts.days;
      } else {
        data.route_geometry = opts.route_geometry ?? defaultGeometry;
        data.waypoints = opts.waypoints ?? defaultWaypoints;
        data.distance_km = opts.distance_km ?? 125;
      }
      const res = await api.post(`${MOCK_BACKEND_URL}/__test__/seed-trip`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
        data,
      });
      if (!res.ok()) {
        throw new Error(`seedTrip failed: ${res.status()} ${await res.text()}`);
      }
      return (await res.json()) as { id: string; title: string };
    },
  };
}

export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("rider@example.com").fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  // Auth.js redirects to "/" on success — wait for the dashboard heading
  // (or any post-login marker) to appear before yielding control.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

export async function authenticate(
  context: BrowserContext,
  user: SeededUser,
): Promise<void> {
  const page = await context.newPage();
  try {
    await loginViaUi(page, user.email, user.password);
  } finally {
    await page.close();
  }
}

interface E2EFixtures {
  mockApi: MockApi;
  user: SeededUser;
  authedPage: Page;
}

// Each test gets:
// - `mockApi`: typed access to the mock backend's control endpoints.
// - `user`: a freshly seeded account, unique per test (no state leakage).
// - `authedPage`: a Page with that user signed in (skips the login UI).
// Tests that want to drive the auth UI directly can use the plain
// `page` fixture and call `mockApi.seedUser` themselves.
export const test = base.extend<E2EFixtures>({
  mockApi: async ({ request }, use) => {
    await use(buildMockApi(request));
  },
  user: async ({ mockApi }, use) => {
    await mockApi.reset();
    const user = await mockApi.seedUser();
    await use(user);
  },
  authedPage: async ({ context, user }, use) => {
    await authenticate(context, user);
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };
