import {
  WAITLIST_CONFIRMATION_SUBJECT,
  renderWaitlistConfirmationHtml,
  renderWaitlistConfirmationText,
} from "./waitlist-confirmation-email.js";

interface Env {
  TARMOTO_WAITLIST: KVNamespace;
  ADMIN_KEY: string;
  ALLOWED_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
}

interface SignupBody {
  email?: string;
  source?: string;
  rider_type?: string;
}

interface SignupRecord {
  email: string;
  source: string;
  rider_type: string;
  timestamp: string;
  ip_country: string;
  user_agent: string;
  unsubscribeToken: string;
  confirmationEmailSentAt?: string;
  unsubscribedAt?: string;
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const UNSUBSCRIBE_KEY_PREFIX = "unsubscribe:";
const EMAIL_KEY_PREFIX = "email:";

function jsonResponse(
  data: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function htmlResponse(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

async function fetchAllSignups(kv: KVNamespace): Promise<SignupRecord[]> {
  const signups: SignupRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: EMAIL_KEY_PREFIX, cursor });
    for (const entry of page.keys) {
      const data = await kv.get(entry.name);
      if (data) signups.push(JSON.parse(data) as SignupRecord);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return signups;
}

function escapeCsv(value: unknown): string {
  const str = String(value ?? "");
  let escaped = str;
  if (/^\s*[=+\-@]/.test(escaped)) {
    escaped = `'${escaped}`;
  }
  if (/[,\n\r"]/.test(escaped)) {
    escaped = `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

function normaliseToken(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9-]{8,128}$/.test(trimmed) ? trimmed : null;
}

function normaliseConfigString(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildUnsubscribeUrl(requestUrl: string, token: string): string {
  const url = new URL("/api/waitlist/unsubscribe", requestUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendWaitlistConfirmationEmail({
  email,
  env,
  requestId,
  unsubscribeToken,
  unsubscribeUrl,
}: {
  email: string;
  env: Env;
  requestId: string;
  unsubscribeToken: string;
  unsubscribeUrl: string;
}): Promise<boolean> {
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
  const body = {
    from,
    to: email,
    subject: WAITLIST_CONFIRMATION_SUBJECT,
    html: renderWaitlistConfirmationHtml(unsubscribeUrl),
    text: renderWaitlistConfirmationText(unsubscribeUrl),
  };

  try {
    const response = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderUnsubscribePage({
  title,
  body,
  actionHtml = "",
}: {
  title: string;
  body: string;
  actionHtml?: string;
}): string {
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
      color: #E8E5DE;
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
    .unsubscribe-actions form { margin: 0; }
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

function renderUnsubscribeConfirmationPage(token: string): string {
  return renderUnsubscribePage({
    title: "Confirm unsubscribe",
    body: "Please confirm that you no longer want to receive Tarmoto waitlist emails.",
    actionHtml: `<div class="unsubscribe-actions">
      <form method="post" action="/api/waitlist/unsubscribe?token=${escapeHtml(token)}">
        <button type="submit">Unsubscribe from waitlist</button>
      </form>
      <a class="secondary-link" href="https://tarmoto.app">Keep my spot</a>
    </div>`,
  });
}

function renderReturnToTarmotoAction(): string {
  return `<div class="unsubscribe-actions">
    <a class="secondary-link" href="https://tarmoto.app">Return to Tarmoto</a>
  </div>`;
}

function invalidUnsubscribeLinkResponse(): Response {
  return htmlResponse(
    404,
    renderUnsubscribePage({
      title: "This unsubscribe link is invalid",
      body: "We could not find a waitlist subscription for this link. You can still contact hello@tarmoto.app if you need help.",
    }),
  );
}

async function handleWaitlistUnsubscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return htmlResponse(
      405,
      renderUnsubscribePage({
        title: "Method not allowed",
        body: "This unsubscribe link must be opened in a browser.",
      }),
      { Allow: "GET, POST" },
    );
  }

  const url = new URL(request.url);
  const token = normaliseToken(url.searchParams.get("token"));
  if (!token) return invalidUnsubscribeLinkResponse();

  const tokenKey = `${UNSUBSCRIBE_KEY_PREFIX}${token}`;
  const email = await env.TARMOTO_WAITLIST.get(tokenKey);
  if (!email) return invalidUnsubscribeLinkResponse();

  const waitlistKey = `${EMAIL_KEY_PREFIX}${email}`;
  const raw = await env.TARMOTO_WAITLIST.get(waitlistKey);
  const record = raw ? (JSON.parse(raw) as SignupRecord) : null;
  if (!record || record.unsubscribeToken !== token) {
    return invalidUnsubscribeLinkResponse();
  }

  if (request.method === "GET") {
    return htmlResponse(200, renderUnsubscribeConfirmationPage(token));
  }

  await env.TARMOTO_WAITLIST.delete(waitlistKey);
  await env.TARMOTO_WAITLIST.delete(tokenKey);

  return htmlResponse(
    200,
    renderUnsubscribePage({
      title: "You're off the waitlist",
      body: "You have been removed from the Tarmoto waitlist. We will not send further waitlist emails to this address.",
      actionHtml: renderReturnToTarmotoAction(),
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (path === "/api/waitlist/unsubscribe") {
        return handleWaitlistUnsubscribe(request, env);
      }

      if (path === "/api/waitlist" && request.method === "POST") {
        const body = (await request.json()) as SignupBody;
        if (!body || typeof body !== "object") {
          return jsonResponse(
            { error: "Invalid request body" },
            400,
            corsHeaders,
          );
        }
        const raw = body.email;
        const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";

        if (!email || email.length < 5 || email.length > 254 || !EMAIL_RE.test(email)) {
          return jsonResponse(
            { error: "Invalid email address" },
            400,
            corsHeaders,
          );
        }

        const waitlistKey = `${EMAIL_KEY_PREFIX}${email}`;
        const existingRaw = await env.TARMOTO_WAITLIST.get(waitlistKey);
        const existing = existingRaw
          ? (JSON.parse(existingRaw) as SignupRecord)
          : null;

        const unsubscribeToken =
          existing?.unsubscribeToken && existing.unsubscribeToken.length > 0
            ? existing.unsubscribeToken
            : crypto.randomUUID();

        const signup: SignupRecord = {
          email,
          source: existing?.source ?? body.source ?? "landing_page",
          rider_type: existing?.rider_type ?? body.rider_type ?? "",
          timestamp: existing?.timestamp ?? new Date().toISOString(),
          ip_country:
            existing?.ip_country ??
            (request as unknown as { cf?: { country?: string } }).cf?.country ??
            "unknown",
          user_agent:
            existing?.user_agent ?? request.headers.get("User-Agent") ?? "",
          unsubscribeToken,
          ...(existing?.confirmationEmailSentAt
            ? { confirmationEmailSentAt: existing.confirmationEmailSentAt }
            : {}),
          ...(existing?.unsubscribedAt
            ? { unsubscribedAt: existing.unsubscribedAt }
            : {}),
        };

        await env.TARMOTO_WAITLIST.put(waitlistKey, JSON.stringify(signup));
        await env.TARMOTO_WAITLIST.put(
          `${UNSUBSCRIBE_KEY_PREFIX}${unsubscribeToken}`,
          email,
        );

        let confirmationEmailSent = false;
        if (!signup.confirmationEmailSentAt) {
          confirmationEmailSent = await sendWaitlistConfirmationEmail({
            email,
            env,
            requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
            unsubscribeToken,
            unsubscribeUrl: buildUnsubscribeUrl(request.url, unsubscribeToken),
          });

          if (confirmationEmailSent) {
            signup.confirmationEmailSentAt = new Date().toISOString();
            await env.TARMOTO_WAITLIST.put(
              waitlistKey,
              JSON.stringify(signup),
            );
          }
        }

        // Best-effort counter — eventual consistency is acceptable for a
        // public waitlist display.
        let count: number;
        if (existing) {
          count = parseInt(
            (await env.TARMOTO_WAITLIST.get("meta:count")) ?? "0",
          );
        } else {
          count =
            parseInt((await env.TARMOTO_WAITLIST.get("meta:count")) ?? "0") + 1;
          await env.TARMOTO_WAITLIST.put("meta:count", count.toString());
        }

        return jsonResponse(
          {
            status: existing ? "already_registered" : "ok",
            message: existing
              ? "You're already on the list!"
              : "Welcome to the waitlist!",
            count,
            alreadySubscribed: Boolean(existing),
            confirmationEmailSent,
          },
          200,
          corsHeaders,
        );
      }

      if (path === "/api/waitlist/count" && request.method === "GET") {
        const count = parseInt(
          (await env.TARMOTO_WAITLIST.get("meta:count")) ?? "0",
        );
        return jsonResponse({ count }, 200, corsHeaders);
      }

      if (path === "/api/waitlist/admin/list" && request.method === "GET") {
        const authKey = url.searchParams.get("key");
        if (authKey !== env.ADMIN_KEY) {
          return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        }

        const signups = await fetchAllSignups(env.TARMOTO_WAITLIST);
        signups.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
        return jsonResponse(
          { count: signups.length, signups },
          200,
          corsHeaders,
        );
      }

      if (path === "/api/waitlist/admin/export" && request.method === "GET") {
        const authKey = url.searchParams.get("key");
        if (authKey !== env.ADMIN_KEY) {
          return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        }

        const signups = await fetchAllSignups(env.TARMOTO_WAITLIST);
        let csv = "email,timestamp,country,source\n";
        for (const s of signups) {
          csv += `${escapeCsv(s.email)},${escapeCsv(s.timestamp)},${escapeCsv(s.ip_country)},${escapeCsv(s.source)}\n`;
        }

        return new Response(csv, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv",
            "Content-Disposition": "attachment; filename=tarmoto_waitlist.csv",
          },
        });
      }

      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse(
        { error: "Server error", detail: message },
        500,
        corsHeaders,
      );
    }
  },
};
