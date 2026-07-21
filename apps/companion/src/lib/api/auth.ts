import { t } from "@/i18n";
import { api, ApiError, openApiData } from "./client";

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
  try {
    const { data } = await openApiData(
      api.POST("/api/v1/auth/register", {
        body: { email, password, display_name: displayName },
      }),
    );
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new ApiError(
        t("An account with that email already exists"),
        error.status,
        error.body,
      );
    }
    throw error;
  }
}
