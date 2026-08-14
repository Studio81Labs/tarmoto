import { cache } from "react";
import {
  resolveFeatureKillSwitch,
  resolveSystemSwitch,
  type FreeToggleFeatureKey,
  type GlobalFeatureStates,
  type SystemFeatureKey,
} from "@tarmoto/shared";
import { apiServer } from "@/lib/api/server";

/** Bounds the delay a slow `/config/flags` can add to a public page render.
 *  Past this we serve the fail-safe answer rather than hold the response. */
const FLAGS_TIMEOUT_MS = 1500;

/**
 * The operator's global `force_off` / `force_on` map, read SERVER-side.
 *
 * The client hooks (`useSystemSwitch`, `useFeatureKillSwitch`) can only hide
 * things after the HTML has already been sent — and for a public page, that
 * HTML is what a crawler and `view-source:` see. Anything a kill switch is
 * meant to take off the public internet has to be resolved here instead, and
 * the data stripped before it is rendered or handed to a client component.
 *
 * Wrapped in React `cache()`, so a render that asks several times — page body,
 * `generateMetadata`, nested components — issues ONE request per request.
 *
 * Returns `null` on any failure, which every helper below reads as ENABLED.
 * See {@link serverSystemSwitch} for why that direction, and note that it is
 * reported rather than swallowed.
 */
export const getServerFlagStates = cache(
  async (): Promise<GlobalFeatureStates | null> => {
    try {
      const { data, response } = await apiServer.GET("/api/v1/config/flags", {
        // Inert today: the Cloudflare adapter leaves `incrementalCache` unset,
        // which OpenNext resolves to its `dummy` cache — `get`/`set` throw
        // `IgnorableError('"Dummy" cache does not cache anything')` — so no
        // server fetch in this app caches across requests, whatever
        // `revalidate` says. Kept because it is the correct intent and starts
        // working the moment #1174 provisions a cache; the per-request dedupe
        // that we actually rely on comes from `cache()` above, which is
        // request-scoped React memoization and involves no adapter.
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(FLAGS_TIMEOUT_MS),
      });
      if (!response.ok || !data) {
        console.warn(
          `[serverFlags] GET /config/flags failed (${response.status}) — ` +
            "serving flags as ENABLED",
        );
        return null;
      }
      return data;
    } catch (error) {
      // `AbortSignal.timeout` rejects with a TimeoutError DOMException; keep it
      // distinguishable from a network/parse failure, because they point an
      // operator at different things (a slow backend vs an unreachable one).
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";
      console.warn(
        timedOut
          ? `[serverFlags] GET /config/flags timed out after ${FLAGS_TIMEOUT_MS}ms — serving flags as ENABLED`
          : `[serverFlags] GET /config/flags errored — serving flags as ENABLED: ${String(error)}`,
      );
      return null;
    }
  },
);

/**
 * A global operator SYSTEM SWITCH (`sys_*`), resolved server-side.
 *
 * Fails SAFE, exactly like `useSystemSwitch`: enabled unless a `force_off` is
 * CONFIRMED. A flags outage must not blank public pages — that turns a backend
 * blip into a site-wide content outage, which is worse than the leak it would
 * be preventing. The trade-off is stated plainly so nobody "hardens" it later
 * without weighing both directions: while `/config/flags` is unreachable, a
 * killed surface keeps serving. That is why the failure is LOGGED — an
 * operator flipping a switch has to be able to tell it did not take.
 */
export async function serverSystemSwitch(
  key: SystemFeatureKey,
): Promise<boolean> {
  const states = await getServerFlagStates();
  return resolveSystemSwitch(key, states?.[key]);
}

/**
 * A FREE-tier operator KILL SWITCH, resolved server-side. Same fail-safe
 * direction and the same shared resolver the client uses — the precedence
 * rules live in `@tarmoto/shared` and are deliberately not restated here, so
 * the server and the browser cannot answer the same flag differently.
 */
export async function serverKillSwitch(
  key: FreeToggleFeatureKey,
): Promise<boolean> {
  const states = await getServerFlagStates();
  return resolveFeatureKillSwitch(key, states?.[key]);
}
