/**
 * Tarmoto Custom Hooks
 */

export { useCommute } from "./useCommute";
export type {
  CommutePhase,
  CommuteHazardView,
  UseCommuteResult,
} from "./useCommute";

export { usePendingUploads } from "./usePendingUploads";
export type { PendingUploadsState } from "./usePendingUploads";

export { useOfflineRegions } from "./useOfflineRegions";
export type {
  AddRegionOutcome,
  UseOfflineRegionsResult,
} from "./useOfflineRegions";

export { useCarPlayRideMirror } from "./useCarPlayRideMirror";

import { useEffect, useRef, useCallback, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import KeepAwake from "react-native-keep-awake";
import { formatDurationSeconds } from "@/theme";

/**
 * Keep screen awake while component is mounted (for ride mode)
 */
export function useKeepAwake(enabled: boolean = true) {
  useEffect(() => {
    if (enabled) {
      KeepAwake.activate();
      return () => KeepAwake.deactivate();
    }
  }, [enabled]);
}

/**
 * Timer hook for ride duration
 */
export function useTimer(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (running) {
      setSeconds(0);
      intervalRef.current = setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  return seconds;
}

/**
 * Format seconds to mm:ss or h:mm:ss. Thin re-export of
 * `formatDurationSeconds` from the theme module — kept under this
 * `use*` name for callers that already import from the hooks barrel,
 * but both call sites land on the same implementation.
 */
export function useFormattedDuration(seconds: number): string {
  return formatDurationSeconds(seconds);
}

/**
 * Track app foreground/background state
 */
export function useAppState(): AppStateStatus {
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState,
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", setAppState);
    return () => sub.remove();
  }, []);

  return appState;
}

/**
 * Debounce a value
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
