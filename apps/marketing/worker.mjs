// Marketing site Worker.
// Serves the Next.js static export from `./out` via the ASSETS binding,
// and handles `/api/waitlist` POST submissions by writing to the
// WAITLIST KV namespace.

import {
  WAITLIST_CONFIRMATION_SUBJECT,
  renderWaitlistConfirmationHtml,
  renderWaitlistConfirmationText,
} from "./waitlist-confirmation-email.mjs";

// RFC 5322-style email check, intentionally simple.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MAX_BODY_BYTES = 4 * 1024;
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const UNSUBSCRIBE_TOKEN_PREFIX = "waitlist-unsubscribe:";

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/waitlist") {
      return handleWaitlist(request, env);
    }

    if (url.pathname === "/api/waitlist/unsubscribe") {
      return handleWaitlistUnsubscribe(request, env);
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse(404, { error: "not_found" });
  },
};

async function handleWaitlist(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      405,
      { error: "method_not_allowed" },
      {
        Allow: "POST",
      },
    );
  }

  if (!env.WAITLIST) {
    return jsonResponse(503, { error: "waitlist_kv_not_configured" });
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse(413, { error: "payload_too_large" });
    }
    return jsonResponse(400, { error: "invalid_json" });
  }

  const email = normaliseEmail(payload?.email);
  if (!email) {
    return jsonResponse(400, { error: "invalid_email" });
  }

  const key = `waitlist:${email}`;
  const existing = await env.WAITLIST.get(key, { type: "json" });
  const now = new Date().toISOString();
  const unsubscribeToken =
    typeof existing?.unsubscribeToken === "string" &&
    existing.unsubscribeToken.length > 0
      ? existing.unsubscribeToken
      : crypto.randomUUID();

  const record = {
    email,
    createdAt: existing?.createdAt ?? now,
    unsubscribeToken,
    ...(existing?.confirmationEmailSentAt
      ? { confirmationEmailSentAt: existing.confirmationEmailSentAt }
      : {}),
    ...(existing?.unsubscribedAt
      ? { unsubscribedAt: existing.unsubscribedAt }
      : {}),
    source: "landing-page",
  };

  await env.WAITLIST.put(key, JSON.stringify(record));
  await env.WAITLIST.put(
    `${UNSUBSCRIBE_TOKEN_PREFIX}${unsubscribeToken}`,
    email,
  );

  let confirmationEmailSent = false;
  if (!record.confirmationEmailSentAt) {
    confirmationEmailSent = await sendWaitlistConfirmationEmail({
      email,
      env,
      requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
      unsubscribeToken,
      unsubscribeUrl: buildUnsubscribeUrl(request.url, unsubscribeToken),
    });

    if (confirmationEmailSent) {
      record.confirmationEmailSentAt = new Date().toISOString();
      await env.WAITLIST.put(key, JSON.stringify(record));
    }
  }

  return jsonResponse(200, {
    ok: true,
    alreadySubscribed: Boolean(existing),
    confirmationEmailSent,
  });
}

async function handleWaitlistUnsubscribe(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return htmlResponse(
      405,
      renderUnsubscribePage({
        title: "Method not allowed",
        body: "This unsubscribe link must be opened in a browser.",
      }),
      {
        Allow: "GET, POST",
      },
    );
  }

  if (!env.WAITLIST) {
    return htmlResponse(
      503,
      renderUnsubscribePage({
        title: "Unsubscribe unavailable",
        body: "We could not update your waitlist preferences right now. Please try again soon.",
      }),
    );
  }

  const url = new URL(request.url);
  const token = normaliseToken(url.searchParams.get("token"));
  if (!token) {
    return invalidUnsubscribeLinkResponse();
  }

  const tokenKey = `${UNSUBSCRIBE_TOKEN_PREFIX}${token}`;
  const email = await env.WAITLIST.get(tokenKey);
  if (!email) {
    return invalidUnsubscribeLinkResponse();
  }

  const waitlistKey = `waitlist:${email}`;
  const record = await env.WAITLIST.get(waitlistKey, { type: "json" });
  if (!record || record.unsubscribeToken !== token) {
    return invalidUnsubscribeLinkResponse();
  }

  if (request.method === "GET") {
    return htmlResponse(200, renderUnsubscribeConfirmationPage(token));
  }

  await env.WAITLIST.delete(waitlistKey);
  await env.WAITLIST.delete(tokenKey);

  return htmlResponse(
    200,
    renderUnsubscribePage({
      title: "You're off the waitlist",
      body: "You have been removed from the Tarmoto waitlist. We will not send further waitlist emails to this address.",
      actionHtml: renderReturnToTarmotoAction(),
    }),
  );
}

function normaliseEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function normaliseToken(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9-]{8,128}$/.test(trimmed) ? trimmed : null;
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore — we're aborting on purpose
      }
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  if (total === 0) return null;

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  return JSON.parse(text);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

async function sendWaitlistConfirmationEmail({
  email,
  env,
  requestId,
  unsubscribeToken,
  unsubscribeUrl,
}) {
  const apiKey = normaliseConfigString(env.RESEND_API_KEY);
  const from = normaliseConfigString(env.RESEND_FROM);
  if (!apiKey || !from) {
    console.warn(
      JSON.stringify({
        event: "waitlist.confirmation_email.skipped",
        reason: "resend_not_configured",
        requestId,
      }),
    );
    return false;
  }

  const idempotencyKey = `waitlist-confirmation-${await sha256Hex(`${email}:${unsubscribeToken}`)}`;
  const responseBody = {
    from,
    to: email,
    reply_to: from,
    subject: WAITLIST_CONFIRMATION_SUBJECT,
    html: renderWaitlistConfirmationHtml(unsubscribeUrl),
    text: renderWaitlistConfirmationText(unsubscribeUrl),
    // Gmail / Yahoo bulk-sender rules: a working List-Unsubscribe
    // header pair is required once volume grows. Both the URL and
    // the one-click POST contract point at the same unsubscribe
    // endpoint the email's "Unsubscribe" footer link uses.
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };

  try {
    const response = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(responseBody),
    });

    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "waitlist.confirmation_email.failed",
          reason: "resend_rejected",
          requestId,
          status: response.status,
        }),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "waitlist.confirmation_email.failed",
        reason: "fetch_error",
        requestId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return false;
  }
}

function buildUnsubscribeUrl(requestUrl, unsubscribeToken) {
  const url = new URL("/api/waitlist/unsubscribe", requestUrl);
  url.searchParams.set("token", unsubscribeToken);
  return url.toString();
}

function normaliseConfigString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function invalidUnsubscribeLinkResponse() {
  return htmlResponse(
    404,
    renderUnsubscribePage({
      title: "This unsubscribe link is invalid",
      body: "We could not find a waitlist subscription for this link. You can still contact hello@tarmoto.app if you need help.",
    }),
  );
}

function renderUnsubscribeConfirmationPage(token) {
  return renderUnsubscribePage({
    title: "Confirm unsubscribe",
    body: "Please confirm that you no longer want to receive Tarmoto waitlist emails.",
    actionHtml: `<div class="unsubscribe-actions">
      <form method="post" action="/api/waitlist/unsubscribe?token=${escapeHtmlAttribute(token)}">
        <button type="submit">Unsubscribe from waitlist</button>
      </form>
      <a class="secondary-link" href="https://tarmoto.app">Keep my spot</a>
    </div>`,
  });
}

function renderReturnToTarmotoAction() {
  return `<div class="unsubscribe-actions">
    <a class="secondary-link" href="https://tarmoto.app">Return to Tarmoto</a>
  </div>`;
}

function renderUnsubscribePage({ title, body, actionHtml = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Tarmoto</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0B0D10;
      color: #E8E5DE;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    }
    main {
      width: min(520px, calc(100% - 48px));
      padding: 40px;
      background: #12161B;
      border: 1px solid rgba(232, 229, 222, 0.16);
      border-radius: 16px;
    }
    h1 {
      margin: 0 0 14px;
      font-size: 28px;
      line-height: 1.2;
    }
    p {
      margin: 0 0 24px;
      color: rgba(232, 229, 222, 0.62);
      font-size: 16px;
      line-height: 1.6;
    }
    a {
      color: #FF6A1A;
      font-weight: 600;
      text-decoration: none;
    }
    .unsubscribe-actions {
      display: flex;
      align-items: center;
      gap: 18px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .unsubscribe-actions form {
      margin: 0;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 20px;
      border: 0;
      border-radius: 10px;
      background: linear-gradient(180deg, #FF7A26 0%, #FF6A1A 100%);
      color: #1A120D;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .secondary-link {
      color: rgba(232, 229, 222, 0.62);
      font-size: 15px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    ${actionHtml}
    ${actionHtml ? "" : '<a href="https://tarmoto.app">Back to tarmoto.app</a>'}
  </main>
</body>
</html>`;
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function htmlResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
