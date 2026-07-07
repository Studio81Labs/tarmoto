import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonRequest } from "./client";

// ── Users endpoints (US-59 profile) ──

export type UserProfileResponse = components["schemas"]["UserResponseDto"];
/** Wire shape of the rider's saved planner defaults (revision 3 §F). */
export type UserRoutePrefsWire = components["schemas"]["UserRoutePrefsDto"];
export type UpdateProfileInput = JsonRequest<"/api/v1/users/me", "patch">;

export const usersApi = {
  getMe: (init?: RequestInit) =>
    openApiData<UserProfileResponse>(
      api.GET("/api/v1/users/me", { ...reqSignal(init) }),
    ),
  uploadAvatar: (file: File) =>
    openApiData<UserProfileResponse>(
      api.POST("/api/v1/users/me/avatar", {
        // Multipart: the schema types the body as `{ file: string }`; send the
        // real File through a FormData bodySerializer so the browser sets the
        // boundary (openapi-fetch skips its JSON Content-Type for FormData).
        body: { file } as unknown as { file: string },
        bodySerializer(body) {
          const form = new FormData();
          form.append("file", (body as unknown as { file: File }).file);
          return form;
        },
      }),
    ),
  updateMe: (data: UpdateProfileInput) =>
    openApiData<UserProfileResponse>(
      api.PATCH("/api/v1/users/me", { body: data }),
    ),
};
