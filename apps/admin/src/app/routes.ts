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
];

function currentKey(): string {
  const key = window.location.hash.replace(/^#\/?/, "");
  return routes.some((r) => r.key === key) ? key : "overview";
}

export function useHashRoute() {
  const [active, setActive] = useState(currentKey());
  useEffect(() => {
    const onChange = () => setActive(currentKey());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((key: string) => {
    window.location.hash = `#/${key}`;
  }, []);
  return { active, navigate };
}
