import { useEffect, useState } from "react";

/**
 * `false` during SSR and the first client render, `true` after mount. Lets a
 * component keep its server output and first client paint identical, then
 * upgrade to browser-dependent output (e.g. runtime-locale date formatting)
 * once hydration is complete — avoiding hydration mismatches.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
