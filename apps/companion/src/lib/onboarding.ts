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

/** Where the step's skip path lands: the dashboard, on the default tier. */
export const PLAN_STEP_SKIP_PATH = "/";

/**
 * Where a Stripe Checkout return is handled. The backend owns the Checkout
 * `success_url`/`cancel_url` and points both at this page
 * (`AccountService.subscriptionPageUrl`), which already verifies the session id
 * and polls until the webhook-written tier settles — so the plan step forwards
 * any `?checkout=` it is handed rather than growing a second, divergent copy of
 * that machinery.
 */
export const SUBSCRIPTION_SETTINGS_PATH = "/settings/subscription";
