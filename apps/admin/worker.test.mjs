import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminRequest } from "./worker.mjs";
import { resolveProxyConfig } from "./adminProxyShared.mjs";

const ENV = {
  TARMOTO_ADMIN_API_BASE_URL: "https://api.tarmoto.test",
  TARMOTO_INTERNAL_API_TOKEN: "s3kret-internal-token",
  ASSETS: {
    fetch: () => new Response("<!doctype html>", { status: 200 }),
  },
};

test("non-/api/v1 paths fall through to the static ASSETS binding", async () => {
  const res = await handleAdminRequest(
    new Request("https://admin.tarmoto.test/users"),
    ENV,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /doctype html/);
});

test("resolveProxyConfig is disabled without base URL + token", () => {
  assert.equal(resolveProxyConfig({}).enabled, false);
  assert.equal(
    resolveProxyConfig({ TARMOTO_ADMIN_API_BASE_URL: "https://x" }).enabled,
    false,
  );
});

test("api requests return 503 when the proxy is unconfigured", async () => {
  const res = await handleAdminRequest(
    new Request("https://admin.tarmoto.test/api/v1/admin/metrics"),
    { ASSETS: ENV.ASSETS },
  );
  assert.equal(res.status, 503);
});

test("proxies /api/v1/* to the backend, injecting the internal token and re-derived IP", async () => {
  let captured;
  const fetchImpl = (req) => {
    captured = req;
    return new Response("{}", { status: 200 });
  };
  const res = await handleAdminRequest(
    new Request("https://admin.tarmoto.test/api/v1/admin/metrics", {
      headers: {
        cookie: "tarmoto_admin_access=abc",
        "cf-connecting-ip": "203.0.113.9",
        // Spoofed identity headers the browser must NOT be able to set.
        "x-internal-token": "attacker-supplied",
        "x-forwarded-for": "10.0.0.1",
      },
    }),
    ENV,
    fetchImpl,
  );
  assert.equal(res.status, 200);
  const upstream = new URL(captured.url);
  assert.equal(upstream.origin, "https://api.tarmoto.test");
  assert.equal(upstream.pathname, "/api/v1/admin/metrics");
  // Session cookie forwarded; internal token is the server's, not the spoof;
  // client IP re-derived from Cloudflare.
  assert.equal(captured.headers.get("cookie"), "tarmoto_admin_access=abc");
  assert.equal(
    captured.headers.get("x-internal-token"),
    "s3kret-internal-token",
  );
  assert.equal(captured.headers.get("x-forwarded-for"), "203.0.113.9");
});

test("preserves multiple Set-Cookie headers from the backend", async () => {
  const fetchImpl = () => {
    const headers = new Headers();
    headers.append("set-cookie", "tarmoto_admin_access=a; HttpOnly");
    headers.append("set-cookie", "tarmoto_admin_refresh=r; HttpOnly");
    return new Response("{}", { status: 200, headers });
  };
  const res = await handleAdminRequest(
    new Request("https://admin.tarmoto.test/api/v1/admin/auth/login", {
      method: "POST",
    }),
    ENV,
    fetchImpl,
  );
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((c) => c.startsWith("tarmoto_admin_access=")));
  assert.ok(cookies.some((c) => c.startsWith("tarmoto_admin_refresh=")));
});

test("rejects an over-large request body with 413", async () => {
  const big = "x".repeat(1024 * 1024 + 1);
  const res = await handleAdminRequest(
    new Request("https://admin.tarmoto.test/api/v1/admin/content", {
      method: "POST",
      body: big,
    }),
    ENV,
    () => new Response("{}", { status: 200 }),
  );
  assert.equal(res.status, 413);
});
