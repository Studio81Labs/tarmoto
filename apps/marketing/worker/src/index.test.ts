import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./index.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

interface WaitlistKv {
  entries: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: true; cursor: undefined }>;
}

function createWaitlistKv(seed: Record<string, unknown> = {}): WaitlistKv {
  const entries = new Map<string, string>(
    Object.entries(seed).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );

  return {
    entries,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix = "" }) {
      const keys = [...entries.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

function signupRequest(body: unknown): Request {
  return new Request("https://tarmoto.app/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseEnv(kv: WaitlistKv) {
  return {
    TARMOTO_WAITLIST: kv as unknown as KVNamespace,
    ADMIN_KEY: "admin-test",
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };
}

test("signup sends a confirmation email through Resend", async () => {
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const kv = createWaitlistKv();
  const env = baseEnv(kv);

  const response = await worker.fetch(
    signupRequest({ email: " Rider@Example.COM " }),
    env,
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.alreadySubscribed, false);
  assert.equal(json.confirmationEmailSent, true);
  assert.equal(fetchCalls.length, 1);

  const [call] = fetchCalls;
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test");
  assert.equal(headers["Content-Type"], "application/json");
  assert.match(headers["Idempotency-Key"], /^waitlist-confirmation-/);
  assert.doesNotMatch(headers["Idempotency-Key"], /rider@example\.com/);

  const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
  assert.equal(body.from, "Tarmoto <hello@tarmoto.app>");
  assert.equal(body.to, "rider@example.com");
  assert.equal(body.subject, "You're on the Tarmoto waitlist");
  assert.match(body.html as string, /We've saved your spot\./);
  assert.match(body.html as string, /tarmoto\.app/);
  assert.match(
    body.html as string,
    /https:\/\/tarmoto\.app\/signup\/unsubscribe\?token=/,
  );
  assert.doesNotMatch(body.html as string, /\{\{unsubscribe_url\}\}/);
  assert.match(body.text as string, /We've saved your spot\./);
  assert.match(
    body.text as string,
    /Unsubscribe: https:\/\/tarmoto\.app\/signup\/unsubscribe\?token=/,
  );
  assert.doesNotMatch(body.text as string, /\{\{unsubscribe_url\}\}/);

  const stored = JSON.parse(
    kv.entries.get("email:rider@example.com") ?? "{}",
  );
  assert.equal(typeof stored.unsubscribeToken, "string");
  assert.equal(typeof stored.confirmationEmailSentAt, "string");
  assert.equal(
    kv.entries.get(`unsubscribe:${stored.unsubscribeToken}`),
    "rider@example.com",
  );
});

test("signup uses a fresh Resend idempotency key for a new KV record", async () => {
  const fetchCalls: { init: RequestInit }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    fetchCalls.push({ init });
    return new Response(JSON.stringify({ id: `email_${fetchCalls.length}` }), {
      status: 200,
    });
  }) as typeof fetch;

  const kv = createWaitlistKv();
  const env = baseEnv(kv);

  await worker.fetch(signupRequest({ email: "rider@example.com" }), env);
  const firstKey = (fetchCalls[0].init.headers as Record<string, string>)[
    "Idempotency-Key"
  ];
  kv.entries.clear();

  await worker.fetch(signupRequest({ email: "rider@example.com" }), env);
  const secondKey = (fetchCalls[1].init.headers as Record<string, string>)[
    "Idempotency-Key"
  ];

  assert.equal(fetchCalls.length, 2);
  assert.notEqual(firstKey, secondKey);
  assert.doesNotMatch(firstKey, /rider@example\.com/);
  assert.doesNotMatch(secondKey, /rider@example\.com/);
});

test("signup does not resend confirmation for a subscriber with confirmation already sent", async () => {
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }) as unknown as typeof fetch;

  const kv = createWaitlistKv({
    "email:rider@example.com": {
      email: "rider@example.com",
      source: "landing_page",
      rider_type: "",
      timestamp: "2026-05-01T12:00:00.000Z",
      ip_country: "CZ",
      user_agent: "test-agent",
      unsubscribeToken: "existing-token",
      confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
    },
    "unsubscribe:existing-token": "rider@example.com",
  });
  const env = baseEnv(kv);

  const response = await worker.fetch(
    signupRequest({ email: "rider@example.com" }),
    env,
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.alreadySubscribed, true);
  assert.equal(json.confirmationEmailSent, false);
  assert.equal(fetchCalls.length, 0);

  const stored = JSON.parse(
    kv.entries.get("email:rider@example.com") ?? "{}",
  );
  assert.equal(stored.timestamp, "2026-05-01T12:00:00.000Z");
  assert.equal(stored.unsubscribeToken, "existing-token");
  assert.equal(stored.confirmationEmailSentAt, "2026-05-01T12:00:01.000Z");
});

test("signup retries confirmation for an existing subscriber without a sent confirmation", async () => {
  const fetchCalls: { init: RequestInit }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    fetchCalls.push({ init });
    return new Response(JSON.stringify({ id: "email_retry" }), { status: 200 });
  }) as typeof fetch;

  const kv = createWaitlistKv({
    "email:rider@example.com": {
      email: "rider@example.com",
      source: "landing_page",
      rider_type: "",
      timestamp: "2026-05-01T12:00:00.000Z",
      ip_country: "CZ",
      user_agent: "test-agent",
      unsubscribeToken: "retry-token",
    },
    "unsubscribe:retry-token": "rider@example.com",
  });
  const env = baseEnv(kv);

  const response = await worker.fetch(
    signupRequest({ email: "rider@example.com" }),
    env,
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.alreadySubscribed, true);
  assert.equal(json.confirmationEmailSent, true);
  assert.equal(fetchCalls.length, 1);

  const stored = JSON.parse(
    kv.entries.get("email:rider@example.com") ?? "{}",
  );
  assert.equal(stored.unsubscribeToken, "retry-token");
  assert.equal(typeof stored.confirmationEmailSentAt, "string");
});

test("signup keeps failed confirmations retryable", async () => {
  console.error = () => {};
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 503,
    });
  }) as typeof fetch;

  const kv = createWaitlistKv();
  const env = baseEnv(kv);

  const response = await worker.fetch(
    signupRequest({ email: "rider@example.com" }),
    env,
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.alreadySubscribed, false);
  assert.equal(json.confirmationEmailSent, false);

  const stored = JSON.parse(
    kv.entries.get("email:rider@example.com") ?? "{}",
  );
  assert.equal(stored.email, "rider@example.com");
  assert.equal(typeof stored.unsubscribeToken, "string");
  assert.equal(stored.confirmationEmailSentAt, undefined);
});

test("signup skips Resend when not configured but still saves the record", async () => {
  console.warn = () => {};
  const fetchCalls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    return new Response("nope", { status: 200 });
  }) as unknown as typeof fetch;

  const kv = createWaitlistKv();
  const env = {
    TARMOTO_WAITLIST: kv as unknown as KVNamespace,
    ADMIN_KEY: "admin-test",
  };

  const response = await worker.fetch(
    signupRequest({ email: "rider@example.com" }),
    env,
  );

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.confirmationEmailSent, false);
  assert.equal(fetchCalls.length, 0);

  const stored = JSON.parse(
    kv.entries.get("email:rider@example.com") ?? "{}",
  );
  assert.equal(typeof stored.unsubscribeToken, "string");
  assert.equal(stored.confirmationEmailSentAt, undefined);
});

test("unsubscribe GET shows a confirmation page without deleting", async () => {
  const kv = createWaitlistKv({
    "email:rider@example.com": {
      email: "rider@example.com",
      source: "landing_page",
      rider_type: "",
      timestamp: "2026-05-01T12:00:00.000Z",
      ip_country: "CZ",
      user_agent: "test-agent",
      unsubscribeToken: "unsubscribe-token",
      confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
    },
    "unsubscribe:unsubscribe-token": "rider@example.com",
  });
  const env = baseEnv(kv);

  const response = await worker.fetch(
    new Request(
      "https://tarmoto.app/signup/unsubscribe?token=unsubscribe-token",
    ),
    env,
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Confirm unsubscribe/);
  assert.match(html, /method="post"/i);
  assert.match(html, /Unsubscribe from waitlist/);
  assert.match(html, /Keep my spot/);
  assert.match(html, /class="unsubscribe-actions"/);

  assert.equal(kv.entries.has("email:rider@example.com"), true);
  assert.equal(kv.entries.has("unsubscribe:unsubscribe-token"), true);
});

test("unsubscribe POST removes subscriber records", async () => {
  const kv = createWaitlistKv({
    "email:rider@example.com": {
      email: "rider@example.com",
      source: "landing_page",
      rider_type: "",
      timestamp: "2026-05-01T12:00:00.000Z",
      ip_country: "CZ",
      user_agent: "test-agent",
      unsubscribeToken: "unsubscribe-token",
      confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
    },
    "unsubscribe:unsubscribe-token": "rider@example.com",
  });
  const env = baseEnv(kv);

  const response = await worker.fetch(
    new Request(
      "https://tarmoto.app/signup/unsubscribe?token=unsubscribe-token",
      { method: "POST" },
    ),
    env,
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /removed from the Tarmoto waitlist/);
  assert.match(html, /Return to Tarmoto/);

  assert.equal(kv.entries.has("email:rider@example.com"), false);
  assert.equal(kv.entries.has("unsubscribe:unsubscribe-token"), false);
});

test("unsubscribe rejects unknown tokens", async () => {
  const kv = createWaitlistKv();
  const env = baseEnv(kv);

  const response = await worker.fetch(
    new Request("https://tarmoto.app/signup/unsubscribe?token=missing-token"),
    env,
  );

  assert.equal(response.status, 404);
  assert.match(await response.text(), /link is invalid/);
});

test("/count returns the meta count value", async () => {
  const kv = createWaitlistKv({ "meta:count": "42" });
  const env = baseEnv(kv);

  const response = await worker.fetch(
    new Request("https://tarmoto.app/count"),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 42 });
});
