export const auth = {
  "Already have an account? Sign in": "Already have an account? Sign in",
  "Check your email": "Check your email",
  "Create your account": "Create your account",
  "Creating account...": "Creating account...",
  "Don't have an account? Create one": "Don't have an account? Create one",
  "Enter your email and we'll send a reset link":
    "Enter your email and we'll send a reset link",
  "If an account exists for {email}, we've sent a password reset link.":
    "If an account exists for {email}, we've sent a password reset link.",
  "Join the Tarmoto rider community": "Join the Tarmoto rider community",
  "Min. {count, plural, one {# character} other {# characters}}":
    "Min. {count, plural, one {# character} other {# characters}}",
  "Open your synced rides, check the essentials, and head out without signal anxiety.":
    "Open your synced rides, check the essentials, and head out without signal anxiety.",
  "Reset password": "Reset password",
  RoadWarrior42: "RoadWarrior42",
  "Send reset link": "Send reset link",
  "Sending...": "Sending...",
  "Sign in to your Tarmoto account": "Sign in to your Tarmoto account",
  "Signing in...": "Signing in...",
  "TARMOTO · COMPANION": "TARMOTO \u00b7 COMPANION",
  "The route is already waiting.": "The route is already waiting.",
  "We couldn't complete social sign-in. Try again or use your password.":
    "We couldn't complete social sign-in. Try again or use your password.",
  "rider@example.com": "rider@example.com",
  "Account created but sign-in failed. Please log in.":
    "Account created but sign-in failed. Please log in.",
  "An unexpected error occurred": "An unexpected error occurred",
  "Invalid email or password": "Invalid email or password",
  "Registration failed": "Registration failed",

  // ── Post-registration plan step (`/welcome/plan`, #1173) ──
  // Signup-flow copy, so it lives with the rest of the auth journey. The PLAN
  // COPY itself — tier names, prices and feature bullets — is not here: it is
  // derived from the shared feature registry by `lib/subscription.ts`, which is
  // the same source the billing settings page renders, so the two cannot drift.
  "Choose how you ride": "Choose how you ride",
  "Choose {plan}": "Choose {plan}",
  "Continue on Free": "Continue on Free",
  "Early rider gift": "Early rider gift",
  "Loading plans…": "Loading plans…",
  "Review subscription settings": "Review subscription settings",
  "Skip for now": "Skip for now",
  "Start on Free and upgrade whenever you want, or pick a paid plan now. You can change this any time in settings.":
    "Start on Free and upgrade whenever you want, or pick a paid plan now. You can change this any time in settings.",
  "Start riding": "Start riding",
  "Taking you to your subscription…": "Taking you to your subscription…",
  "We could not load the plans just now.":
    "We could not load the plans just now.",
  "Welcome aboard": "Welcome aboard",
  "What you get": "What you get",
  "You can choose or change your plan any time in settings.":
    "You can choose or change your plan any time in settings.",
  "You joined early, so your account starts on {plan} — a founding-rider gift, not a trial. It stays yours even after we stop handing it out, and there is nothing to pay and nothing to cancel.":
    "You joined early, so your account starts on {plan} — a founding-rider gift, not a trial. It stays yours even after we stop handing it out, and there is nothing to pay and nothing to cancel.",
  "Your account is ready": "Your account is ready",
  "Your plan is already set up.": "Your plan is already set up.",
  "{plan} is on us": "{plan} is on us",
} as const;
