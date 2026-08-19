import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./worker.mjs";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("waitlist signup sends a confirmation email through Resend", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const env = {
    WAITLIST: createWaitlistKv(),
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };

  const response = await worker.fetch(
    waitlistRequest({ email: " Rider@Example.COM " }),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    alreadySubscribed: false,
    confirmationEmailSent: true,
  });
  assert.equal(fetchCalls.length, 1);

  const [call] = fetchCalls;
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer re_test");
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.match(call.init.headers["Idempotency-Key"], /^waitlist-confirmation-/);
  assert.doesNotMatch(
    call.init.headers["Idempotency-Key"],
    /rider@example\.com/,
  );

  const body = JSON.parse(call.init.body);
  assert.equal(body.from, "Tarmoto <hello@tarmoto.app>");
  assert.equal(body.to, "rider@example.com");
  assert.equal(body.reply_to, "Tarmoto <hello@tarmoto.app>");
  assert.equal(body.subject, "You're on the Tarmoto waitlist");
  assert.match(body.html, /You're <em[^>]*>on the list\.<\/em>/);
  assert.match(body.html, /Thanks for joining the Tarmoto waitlist/);

  // §02 now reads as a single sentence — the older "First / Next /
  // Then" timeline and the "We're a small team building Tarmoto…"
  // paragraph are gone.
  assert.match(body.html, /What's next/);
  assert.match(
    body.html,
    /Beta access will roll out gradually in small batches\./,
  );
  assert.doesNotMatch(body.html, /Private beta, in small batches/);
  assert.doesNotMatch(body.html, /Wider European beta/);
  assert.doesNotMatch(body.html, /We're a small team building Tarmoto/);

  // Footer micro-tagline replaces the previous "Early beta ·
  // prelaunch" stamp.
  assert.match(body.html, /Route planning for riders\./);
  assert.doesNotMatch(body.html, /Early beta · prelaunch/);

  // Logo: PNG inlined as a base64 data URI so it ships with the
  // email body itself — no external asset URL to resolve at open
  // time. Letter "T" is kept as the image-blocked fallback via
  // alt text + the cell's orange bgcolor.
  assert.match(body.html, /src="data:image\/png;base64,iVBOR/);
  assert.match(body.html, /alt="T"/);
  assert.match(body.html, /bgcolor="#FF6A1A"/);
  // Brand identity copy + the unsubscribe link both point at
  // tarmoto.app so we keep at least one assertion against the
  // canonical domain.
  assert.match(body.html, /https:\/\/tarmoto\.app/);
  assert.match(
    body.html,
    /https:\/\/tarmoto\.app\/api\/waitlist\/unsubscribe\?token=/,
  );
  assert.doesNotMatch(body.html, /\{\{unsubscribe_url\}\}/);
  assert.doesNotMatch(body.html, /\{\{year\}\}/);
  assert.match(body.text, /You're on the list\./);
  assert.match(body.text, /Thanks for joining the Tarmoto waitlist/);
  assert.match(body.text, /What's next/);
  assert.match(
    body.text,
    /Beta access will roll out gradually in small batches\./,
  );
  assert.doesNotMatch(body.text, /First.*Private beta/);
  assert.doesNotMatch(body.text, /We're a small team/);
  assert.match(body.text, /route planning for riders/i);
  assert.match(
    body.text,
    /Unsubscribe: https:\/\/tarmoto\.app\/api\/waitlist\/unsubscribe\?token=/,
  );
  assert.doesNotMatch(body.text, /\{\{unsubscribe_url\}\}/);
  assert.doesNotMatch(body.text, /\{\{year\}\}/);

  // List-Unsubscribe / one-click headers must point at the same
  // unsubscribe endpoint as the footer link so Gmail/Yahoo accept
  // the bulk-sender contract.
  assert.match(
    body.headers["List-Unsubscribe"],
    /^<https:\/\/tarmoto\.app\/api\/waitlist\/unsubscribe\?token=[a-z0-9-]+>$/,
  );
  assert.equal(
    body.headers["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );

  const stored = JSON.parse(
    env.WAITLIST.entries.get("waitlist:rider@example.com"),
  );
  assert.equal(typeof stored.unsubscribeToken, "string");
  assert.equal(typeof stored.confirmationEmailSentAt, "string");
  assert.equal(
    env.WAITLIST.entries.get(`waitlist-unsubscribe:${stored.unsubscribeToken}`),
    "rider@example.com",
  );
});

test("waitlist signup uses a new Resend idempotency key for a new KV record", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: `email_${fetchCalls.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const env = {
    WAITLIST: createWaitlistKv(),
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };

  await worker.fetch(
    waitlistRequest({ email: "rider@example.com" }),
    env,
    createExecutionContext(),
  );
  const firstKey = fetchCalls[0].init.headers["Idempotency-Key"];
  env.WAITLIST.entries.clear();

  await worker.fetch(
    waitlistRequest({ email: "rider@example.com" }),
    env,
    createExecutionContext(),
  );
  const secondKey = fetchCalls[1].init.headers["Idempotency-Key"];

  assert.equal(fetchCalls.length, 2);
  assert.notEqual(firstKey, secondKey);
  assert.doesNotMatch(firstKey, /rider@example\.com/);
  assert.doesNotMatch(secondKey, /rider@example\.com/);
});

test("waitlist signup does not resend confirmation for an existing subscriber with a sent confirmation", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  };

  const env = {
    WAITLIST: createWaitlistKv({
      "waitlist:rider@example.com": {
        email: "rider@example.com",
        createdAt: "2026-05-01T12:00:00.000Z",
        unsubscribeToken: "existing-token",
        confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
        unsubscribedAt: "2026-05-02T09:30:00.000Z",
        source: "landing-page",
      },
    }),
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };

  const response = await worker.fetch(
    waitlistRequest({ email: "rider@example.com" }),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    alreadySubscribed: true,
    confirmationEmailSent: false,
  });
  assert.equal(fetchCalls.length, 0);

  const stored = JSON.parse(
    env.WAITLIST.entries.get("waitlist:rider@example.com"),
  );
  assert.equal(stored.createdAt, "2026-05-01T12:00:00.000Z");
  assert.equal(stored.unsubscribeToken, "existing-token");
  assert.equal(stored.confirmationEmailSentAt, "2026-05-01T12:00:01.000Z");
  assert.equal(stored.unsubscribedAt, "2026-05-02T09:30:00.000Z");
});

test("waitlist signup retries confirmation for an existing subscriber without a sent confirmation", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ id: "email_retry" }), { status: 200 });
  };

  const env = {
    WAITLIST: createWaitlistKv({
      "waitlist:rider@example.com": {
        email: "rider@example.com",
        createdAt: "2026-05-01T12:00:00.000Z",
        unsubscribeToken: "retry-token",
        source: "landing-page",
      },
    }),
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };

  const response = await worker.fetch(
    waitlistRequest({ email: "rider@example.com" }),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    alreadySubscribed: true,
    confirmationEmailSent: true,
  });
  assert.equal(fetchCalls.length, 1);

  const stored = JSON.parse(
    env.WAITLIST.entries.get("waitlist:rider@example.com"),
  );
  assert.equal(stored.createdAt, "2026-05-01T12:00:00.000Z");
  assert.equal(stored.unsubscribeToken, "retry-token");
  assert.equal(typeof stored.confirmationEmailSentAt, "string");
});

test("waitlist signup keeps failed confirmations retryable", async () => {
  console.error = () => {};

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 503,
    });
  };

  const env = {
    WAITLIST: createWaitlistKv(),
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Tarmoto <hello@tarmoto.app>",
  };

  const response = await worker.fetch(
    waitlistRequest({ email: "rider@example.com" }),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    alreadySubscribed: false,
    confirmationEmailSent: false,
  });

  const stored = JSON.parse(
    env.WAITLIST.entries.get("waitlist:rider@example.com"),
  );
  assert.equal(stored.email, "rider@example.com");
  assert.equal(typeof stored.unsubscribeToken, "string");
  assert.equal(stored.confirmationEmailSentAt, undefined);
});

test("waitlist unsubscribe GET only shows a confirmation page", async () => {
  const env = {
    WAITLIST: createWaitlistKv({
      "waitlist:rider@example.com": {
        email: "rider@example.com",
        createdAt: "2026-05-01T12:00:00.000Z",
        unsubscribeToken: "unsubscribe-token",
        confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
        source: "landing-page",
      },
      "waitlist-unsubscribe:unsubscribe-token": "rider@example.com",
    }),
  };

  const response = await worker.fetch(
    new Request(
      "https://tarmoto.app/api/waitlist/unsubscribe?token=unsubscribe-token",
    ),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Confirm unsubscribe/);
  assert.match(html, /method="post"/i);
  assert.match(html, /Unsubscribe from waitlist/);
  assert.match(html, /Keep my spot/);
  assert.match(html, /class="unsubscribe-actions"/);

  const stored = JSON.parse(
    env.WAITLIST.entries.get("waitlist:rider@example.com"),
  );
  assert.equal(stored.email, "rider@example.com");
  assert.equal(stored.unsubscribedAt, undefined);
});

test("waitlist unsubscribe POST removes subscriber records", async () => {
  const env = {
    WAITLIST: createWaitlistKv({
      "waitlist:rider@example.com": {
        email: "rider@example.com",
        createdAt: "2026-05-01T12:00:00.000Z",
        unsubscribeToken: "unsubscribe-token",
        confirmationEmailSentAt: "2026-05-01T12:00:01.000Z",
        source: "landing-page",
      },
      "waitlist-unsubscribe:unsubscribe-token": "rider@example.com",
    }),
  };

  const response = await worker.fetch(
    new Request(
      "https://tarmoto.app/api/waitlist/unsubscribe?token=unsubscribe-token",
      { method: "POST" },
    ),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /removed from the Tarmoto waitlist/);
  assert.match(html, /Return to Tarmoto/);
  assert.match(html, /class="secondary-link"/);
  assert.doesNotMatch(html, /Back to tarmoto\.app/);

  assert.equal(env.WAITLIST.entries.has("waitlist:rider@example.com"), false);
  assert.equal(
    env.WAITLIST.entries.has("waitlist-unsubscribe:unsubscribe-token"),
    false,
  );
});

test("waitlist unsubscribe rejects unknown tokens", async () => {
  const env = {
    WAITLIST: createWaitlistKv(),
  };

  const response = await worker.fetch(
    new Request("https://tarmoto.app/api/waitlist/unsubscribe?token=missing"),
    env,
    createExecutionContext(),
  );

  assert.equal(response.status, 404);
  assert.match(await response.text(), /link is invalid/);
});

function waitlistRequest(body) {
  return new Request("https://tarmoto.app/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createWaitlistKv(seed = {}) {
  const entries = new Map(
    Object.entries(seed).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );

  return {
    entries,
    async get(key, options) {
      const value = entries.get(key) ?? null;
      if (options?.type === "json" && value) {
        return JSON.parse(value);
      }
      return value;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

function createExecutionContext() {
  return {
    waitUntil(promise) {
      return promise;
    },
  };
}
