import { useCallback, useEffect, useState } from "react";

export interface AdminRoute {
  key: string;
  label: string;
}

export const routes: AdminRoute[] = [
  { key: "overview", label: "Overview" },
  { key: "users", label: "Users" },
  { key: "feature-flags", label: "Feature Flags" },
  { key: "content", label: "Content" },
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
