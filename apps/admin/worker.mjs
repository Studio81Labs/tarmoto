// Tarmoto admin console — Cloudflare Worker.
//
// Serves the static console build (./dist via the ASSETS binding, SPA
// fallback) and proxies the admin API same-origin:
//
//   * /api/v1/*   same-origin proxy to the NestJS backend
//
// The proxy keeps the host-scoped tarmoto_admin_* session cookies first-party
// on this origin (see adminProxyShared.mjs) and injects the x-internal-token
// so the backend's InternalGuard accepts the request (defence in depth). It is
// otherwise transparent: strip spoofable identity headers, re-derive the
// client IP from Cloudflare, forward everything else. Admin auth itself
// (session cookie + SSO) is validated by the backend, not here.

import {
  API_PROXY_PREFIX,
  HOP_BY_HOP_HEADERS,
  INTERNAL_TOKEN_HEADER,
  MAX_PROXY_BODY_BYTES,
  resolveProxyConfig,
  shouldForwardProxyHeader,
} from "./adminProxyShared.mjs";

export default {
  fetch(request, env, ctx) {
    void ctx;
    return handleAdminRequest(request, env);
  },
};

export async function handleAdminRequest(request, env, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname.startsWith(API_PROXY_PREFIX)) {
    return proxyApiRequest({ request, requestUrl, env, fetchImpl });
  }

  if (env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  return jsonResponse(404, { error: "not_found" });
}

async function proxyApiRequest({ request, requestUrl, env, fetchImpl }) {
  const config = resolveProxyConfig(env);
  if (!config.enabled) {
    return jsonResponse(503, { error: "admin_api_proxy_not_configured" });
  }

  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    config.baseUrl,
  );
  const init = {
    method: request.method,
    headers: buildProxyHeaders(request.headers, config.internalToken),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      init.body = await readRequestBody(request);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonResponse(413, { error: "payload_too_large" });
      }
      throw error;
    }
  }

  try {
    const upstreamResponse = await fetchImpl(new Request(upstreamUrl, init));
    return forwardProxyResponse(request, upstreamResponse);
  } catch (error) {
    console.error(
      JSON.stringify({
        event_key: "admin.worker.proxy.failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return jsonResponse(502, { error: "admin_api_proxy_unavailable" });
  }
}

function forwardProxyResponse(request, upstreamResponse) {
  const headers = new Headers();
  // Set-Cookie must not be combined into one comma-joined header — the backend
  // sets tarmoto_admin_access + tarmoto_admin_refresh together on login.
  const explicitSetCookies =
    typeof upstreamResponse.headers.getSetCookie === "function"
      ? upstreamResponse.headers.getSetCookie()
      : [];

  for (const [name, value] of upstreamResponse.headers) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized === "set-cookie" && explicitSetCookies.length > 0) continue;
    headers.append(name, value);
  }

  for (const cookie of explicitSetCookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(
    request.method === "HEAD" ? null : upstreamResponse.body,
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    },
  );
}

function buildProxyHeaders(sourceHeaders, internalToken) {
  const headers = new Headers();

  for (const [name, value] of sourceHeaders) {
    if (!shouldForwardProxyHeader(name)) continue;
    headers.set(name, value);
  }

  const clientIp = sourceHeaders.get("cf-connecting-ip")?.trim() || "unknown";
  headers.set(INTERNAL_TOKEN_HEADER, internalToken);
  headers.set("x-forwarded-for", clientIp);
  headers.set("x-real-ip", clientIp);
  return headers;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("admin proxy request body exceeds the configured limit");
    this.name = "PayloadTooLargeError";
  }
}

async function readRequestBody(request) {
  const contentLength = readContentLength(request.headers);
  if (contentLength !== null && contentLength > MAX_PROXY_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PROXY_BODY_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function readContentLength(headers) {
  const value = headers.get("content-length");
  if (!value) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
