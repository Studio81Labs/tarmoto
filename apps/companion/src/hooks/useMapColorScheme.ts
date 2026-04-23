"use client";

import { useEffect, useState } from "react";
import { toMapColorScheme, type MapColorScheme } from "@/lib/map-style";

const QUERY = "(prefers-color-scheme: dark)";

export function useMapColorScheme(): MapColorScheme {
  const [colorScheme, setColorScheme] = useState<MapColorScheme>(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) {
      return "light";
    }

    return toMapColorScheme(window.matchMedia(QUERY).matches);
  });

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;

    const mediaQuery = window.matchMedia(QUERY);
    const update = (matchesDark: boolean) => {
      setColorScheme(toMapColorScheme(matchesDark));
    };
    const handleChange = (event: MediaQueryListEvent) => {
      update(event.matches);
    };

    update(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return colorScheme;
}
