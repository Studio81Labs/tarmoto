import { apiClient } from "../data/apiClient.js";

export type AdminRole = "read_only" | "support" | "admin" | "super_admin";
export interface AdminUserView {
  id: string;
  email: string;
  role: AdminRole;
  status: "active" | "disabled";
}

export const adminAuthApi = {
  async getCurrentAdmin(): Promise<AdminUserView | null> {
    const { data, error } = await apiClient.GET("/api/v1/admin/auth/me");
    if (error || !data) return null;
    return data.user as AdminUserView;
  },

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AdminUserView> {
    const { data, error } = await apiClient.POST("/api/v1/admin/auth/login", {
      body: { email, password },
    });
    if (error || !data) throw new Error("Invalid credentials");
    return data.user as AdminUserView;
  },

  async logout(): Promise<void> {
    await apiClient.POST("/api/v1/admin/auth/logout", {});
  },

  startGithubSso(): void {
    window.location.href = "/api/v1/admin/auth/sso/github/start";
  },
};
