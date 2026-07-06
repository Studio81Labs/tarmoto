import { apiFetch } from "./client";

// ── Auth helpers ──

export async function forgotPassword(email: string) {
  await apiFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// Used by the registration page before Auth.js signIn.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const { data } = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  return data;
}
