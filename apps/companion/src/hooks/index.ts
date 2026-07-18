import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";

/**
 * Debounced value hook — useful for search inputs
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Window size hook for responsive layouts
 */
export function useWindowSize() {
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handleResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return size;
}

/**
 * Click-outside detection for dropdowns and modals
 */
export function useClickOutside(callback: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [callback]);

  return ref;
}

/**
 * Dropdown state hook — open/close, click-outside, and escape-key dismiss.
 * Returns a ref to attach to the dropdown container and open/close/toggle
 * controls.
 */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const ref = useClickOutside(close);

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  return { open, close, toggle, ref };
}

/**
 * Reactive CSS media-query match, via `useSyncExternalStore` so the CLIENT
 * reads the real match *synchronously* on first render — a component that
 * (re)mounts on navigation lands on the correct value with no expand→collapse
 * flash. `getServerSnapshot` returns `ssrDefault` on the server and during
 * hydration (so SSR markup and the first client render agree — no mismatch),
 * then the store settles to the live value.
 */
export function useMediaQuery(query: string, ssrDefault = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return () => {};
      }
      const mql = window.matchMedia(query);
      // Older Safari / iPadOS WebKit expose only the deprecated
      // `addListener`/`removeListener` — feature-detect so those (tablet!)
      // users don't hit a runtime throw.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : ssrDefault;
  return useSyncExternalStore(subscribe, getSnapshot, () => ssrDefault);
}

/**
 * Local storage hook with JSON serialization.
 *
 * SSR-safe: the first render always returns `initial` (both on the
 * server and on the client's hydration pass) so the markup matches
 * across both, then a post-mount effect reads the stored value and
 * applies it. The trade-off is a single render flicker on first
 * paint for users whose stored value differs from `initial`, which
 * we accept in exchange for a clean hydration with no React
 * warnings or content-shift mismatches.
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      // localStorage may be unavailable (quota, private mode). The
      // hook still works; we just stay on `initial`.
    }
    // We deliberately only read on mount — subsequent writes flow
    // through `setValue` and are persisted by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const didMountRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip the initial write so we don't overwrite a stored value
    // with `initial` on the first paint before the read-effect runs.
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota / private mode — best-effort.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
