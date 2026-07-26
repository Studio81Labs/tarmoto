import { act, renderHook } from "@testing-library/react-native";
import { useAuthStore } from "@/stores";
import { useEntitlements, useFeature, useLimit } from "@/hooks/useEntitlements";

// Not typed `as never` here — the spread below needs a real object type.
// Each call site casts the (possibly spread) literal to `never` instead.
const baseUser = {
  id: "u1",
  subscription_tier: "free",
  features: { gpx_export: false, basic_navigation: true },
  limits: {
    max_active_trips: 1,
    road_quality_max_zoom: 12,
    max_trip_collaborators: 0,
  },
};

afterEach(() => useAuthStore.setState({ user: null }));

// `renderHook` is async in the installed @testing-library/react-native
// (14.x) — see useCommute.test.tsx for the same `await renderHook(...)`
// idiom used elsewhere in this repo.

it("reads the resolved snapshot from the auth store", async () => {
  useAuthStore.setState({ user: baseUser as never });
  const { result } = await renderHook(() => useEntitlements());
  expect(result.current.tier).toBe("free");
  expect(result.current.isResolved).toBe(true);
});

it("useFeature reads the resolved toggle; fails closed when logged out", async () => {
  useAuthStore.setState({ user: baseUser as never });
  const { result } = await renderHook(() => useFeature("gpx_export"));
  expect(result.current.enabled).toBe(false);
  await act(() => useAuthStore.setState({ user: null }));
  expect(result.current.enabled).toBe(false);
  expect(result.current.isResolved).toBe(false);
});

it("useLimit reads the resolved numeric cap (null = unlimited)", async () => {
  useAuthStore.setState({ user: baseUser as never });
  const { result } = await renderHook(() => useLimit("road_quality_max_zoom"));
  expect(result.current.limit).toBe(12);
  await act(() =>
    useAuthStore.setState({
      user: { ...baseUser, limits: { road_quality_max_zoom: null } } as never,
    }),
  );
  expect(result.current.limit).toBeNull();
});

// A legacy cached profile serialized before the entitlement fields existed
// hydrates as a non-null user with `features`/`limits` undefined. Treating that
// as resolved would read the absent snapshot as unlimited (limit null → z22),
// leaking the client-only overlay. Resolution must derive from the snapshot.
it("useLimit fails closed when the cached snapshot lacks `limits`", async () => {
  const legacyUser = { id: "u1", subscription_tier: "free" };
  useAuthStore.setState({ user: legacyUser as never });
  const { result } = await renderHook(() => useLimit("road_quality_max_zoom"));
  expect(result.current.isResolved).toBe(false);
  expect(result.current.limit).toBeNull();
});

it("useFeature fails closed when the cached snapshot lacks `features`", async () => {
  const legacyUser = { id: "u1", subscription_tier: "pro" };
  useAuthStore.setState({ user: legacyUser as never });
  const { result } = await renderHook(() => useFeature("gpx_export"));
  expect(result.current.isResolved).toBe(false);
  expect(result.current.enabled).toBe(false);
});

it("useEntitlements is unresolved unless both snapshot slices are present", async () => {
  useAuthStore.setState({
    user: { ...baseUser, limits: undefined } as never,
  });
  const { result } = await renderHook(() => useEntitlements());
  expect(result.current.isResolved).toBe(false);
});
