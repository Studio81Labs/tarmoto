"use client";

import { useEffect, useState } from "react";

/**
 * Debounce a loading flag before showing a spinner: returns true only once
 * `loading` has been continuously true for `delayMs`. Fast responses (the
 * common case against a warm backend) then transition straight from old
 * content to new content instead of flashing a loader for a frame or two —
 * the spinner only ever appears for genuinely slow loads.
 *
 * While `loading` is true but the delay hasn't elapsed, render the layout
 * shell (or nothing) in place of the spinner — never the empty/error state,
 * which would flash a wrong message instead.
 */
export function useDelayedLoading(loading: boolean, delayMs = 250): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [loading, delayMs]);
  return show;
}
