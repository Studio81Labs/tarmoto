import { api, openApiData } from "./client";

// ── Auth helpers ──

export async function forgotPassword(email: string) {
  await openApiData(
    api.POST("/api/v1/auth/forgot-password", { body: { email } }),
  );
}

// Used by the registration page before Auth.js signIn.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const { data } = await openApiData(
    api.POST("/api/v1/auth/register", {
      body: { email, password, display_name: displayName },
    }),
  );
  return data;
}
