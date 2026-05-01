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

export interface MockApi {
  reset(): Promise<void>;
  seedUser(opts?: SeedOpts): Promise<SeededUser>;
  setSubscription(
    userId: string,
    tier: "free" | "premium" | "pro",
  ): Promise<void>;
  addTripMember(tripId: string, userId: string): Promise<void>;
  createTrip(
    user: SeededUser,
    payload: { title: string; num_days?: number },
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
