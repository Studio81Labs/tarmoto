interface Env {
  TARMOTO_WAITLIST: KVNamespace;
  ADMIN_KEY: string;
  ALLOWED_ORIGIN?: string;
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
}

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

async function fetchAllSignups(
  kv: KVNamespace,
): Promise<SignupRecord[]> {
  const signups: SignupRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "email:", cursor });
    for (const entry of page.keys) {
      const data = await kv.get(entry.name);
      if (data) signups.push(JSON.parse(data) as SignupRecord);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return signups;
}

function escapeCsv(value: string): string {
  let escaped = value;
  if (/^[=+\-@]/.test(escaped)) {
    escaped = `'${escaped}`;
  }
  if (/[,\n\r"]/.test(escaped)) {
    escaped = `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
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
      if (path === "/signup" && request.method === "POST") {
        const body = (await request.json()) as SignupBody;
        const email = (body.email ?? "").trim().toLowerCase();

        if (!email || !email.includes("@") || !email.includes(".")) {
          return jsonResponse(
            { error: "Invalid email address" },
            400,
            corsHeaders,
          );
        }

        const existing = await env.TARMOTO_WAITLIST.get(`email:${email}`);
        if (existing) {
          return jsonResponse(
            {
              status: "already_registered",
              message: "You're already on the list!",
            },
            200,
            corsHeaders,
          );
        }

        const signup: SignupRecord = {
          email,
          source: body.source ?? "landing_page",
          rider_type: body.rider_type ?? "",
          timestamp: new Date().toISOString(),
          ip_country:
            (request as unknown as { cf?: { country?: string } }).cf?.country ??
            "unknown",
          user_agent: request.headers.get("User-Agent") ?? "",
        };

        await env.TARMOTO_WAITLIST.put(
          `email:${email}`,
          JSON.stringify(signup),
        );

        // Best-effort counter — eventual consistency is acceptable for a
        // public waitlist display. Use a per-signup key timestamp to derive
        // a rough count when consistency matters.
        const count =
          parseInt((await env.TARMOTO_WAITLIST.get("meta:count")) ?? "0") + 1;
        await env.TARMOTO_WAITLIST.put("meta:count", count.toString());

        return jsonResponse(
          { status: "ok", message: "Welcome to the waitlist!", count },
          200,
          corsHeaders,
        );
      }

      if (path === "/count" && request.method === "GET") {
        const count = parseInt(
          (await env.TARMOTO_WAITLIST.get("meta:count")) ?? "0",
        );
        return jsonResponse({ count }, 200, corsHeaders);
      }

      if (path === "/admin/list" && request.method === "GET") {
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

      if (path === "/admin/export" && request.method === "GET") {
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
