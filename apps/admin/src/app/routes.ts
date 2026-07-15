import { useCallback, useEffect, useState } from "react";
import type { AdminRole } from "../auth/adminAuthApi.js";

export interface AdminRoute {
  key: string;
  label: string;
  /** Minimum role required to view this route. Undefined = accessible to all authenticated admins. */
  minRole?: AdminRole;
}

export const routes: AdminRoute[] = [
  { key: "overview", label: "Overview", minRole: "read_only" },
  { key: "users", label: "Users", minRole: "support" },
  { key: "administrators", label: "Administrators", minRole: "admin" },
  { key: "feature-flags", label: "Feature Flags", minRole: "admin" },
  { key: "content", label: "Content", minRole: "support" },
  { key: "email", label: "Email Log", minRole: "support" },
  { key: "email-templates", label: "Email Templates", minRole: "support" },
  { key: "poi-imports", label: "POI Imports", minRole: "support" },
];

function currentSegments(): string[] {
  return window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

function currentKey(): string {
  const key = currentSegments()[0] ?? "";
  return routes.some((r) => r.key === key) ? key : "overview";
}

export function useHashRoute() {
  const [, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const segments = currentSegments();
  const active = currentKey();
  const params = segments.slice(1);
  const navigate = useCallback((path: string) => {
    window.location.hash = `#/${path}`;
  }, []);
  return { active, params, navigate };
}
