import type { components } from "@tarmoto/openapi-client";
import { apiClient } from "../data/apiClient.js";

/** Admin identity + role — the generated `AdminUserViewDto`. */
export type AdminUserView = components["schemas"]["AdminUserViewDto"];
export type AdminRole = AdminUserView["role"];

export const adminAuthApi = {
  async getConfig(): Promise<{ passwordLoginEnabled: boolean }> {
    try {
      const { data, error } = await apiClient.GET("/admin/auth/config");
      if (error || !data) return { passwordLoginEnabled: import.meta.env.DEV };
      return data;
    } catch {
      return { passwordLoginEnabled: import.meta.env.DEV };
    }
  },

  async getCurrentAdmin(): Promise<AdminUserView | null> {
    try {
      const { data, error } = await apiClient.GET("/admin/auth/me");
      if (error || !data) return null;
      return data.user;
    } catch {
      return null;
    }
  },

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AdminUserView> {
    const { data, error } = await apiClient.POST("/admin/auth/login", {
      body: { email, password },
    });
    if (error || !data) throw new Error("Invalid credentials");
    return data.user;
  },

  async logout(): Promise<void> {
    const { error } = await apiClient.POST("/admin/auth/logout", {});
    if (error) throw new Error("Logout failed");
  },

  startGithubSso(): void {
    window.location.href = "/admin/auth/sso/github/start";
  },
};
