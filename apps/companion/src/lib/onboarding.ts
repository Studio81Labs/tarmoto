/**
 * The post-registration plan selection step (#1173).
 *
 * Deliberately NOT under `/register`: `middleware.ts` prefix-matches that path
 * as an auth page and redirects any AUTHENTICATED visitor to `/`, which is
 * exactly what a just-signed-in rider is. `/welcome` is listed in
 * `PROTECTED_PATHS` instead, so the step requires the session it reads.
 *
 * Shared so the register form's redirect and the step's own route cannot drift.
 */
export const PLAN_STEP_PATH = "/welcome/plan";

/**
 * The dashboard root. Two roles, and they are the same fact:
 *
 * - where the step's skip path lands (the rider keeps the tier registration
 *   already gave them);
 * - the value a `callbackUrl` resolves to when the rider asked for NOWHERE in
 *   particular — an absent, cross-origin or malformed param, and equally the
 *   `callbackUrl=/` that `middleware.ts` mints for a logged-out visit to `/`
 *   and `LoginForm` forwards to `/register`. Those are not a destination the
 *   rider chose, so they must not suppress the plan step.
 */
export const DASHBOARD_PATH = "/";

/**
 * Where a Stripe Checkout return is handled. The backend owns the Checkout
 * `success_url`/`cancel_url` and points both at this page
 * (`AccountService.subscriptionPageUrl`), which already verifies the session id
 * and polls until the webhook-written tier settles — so the plan step forwards
 * any `?checkout=` it is handed rather than growing a second, divergent copy of
 * that machinery.
 */
export const SUBSCRIPTION_SETTINGS_PATH = "/settings/subscription";
