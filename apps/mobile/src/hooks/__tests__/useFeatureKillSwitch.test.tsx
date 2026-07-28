/**
 * useFeatureKillSwitchActive — reactive read of a free-tier kill switch.
 *
 * The point of the hook (over the plain synchronous cache read) is that a
 * component gating a MOUNTED surface re-renders when the refresh monitor
 * persists a fresh `/config/flags` map — an MMKV write alone triggers no
 * re-render. These tests exercise the cache → hook wiring end to end (no mock
 * of the cache) so the subscription actually fires.
 */

import { act, renderHook } from "@testing-library/react-native";
import { useFeatureKillSwitchActive } from "../useFeatureKillSwitch";
import {
  __setStorageForTest,
  setCachedSystemSwitchStates,
} from "@/services/systemSwitchCache";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
  };
}

describe("useFeatureKillSwitchActive", () => {
  beforeEach(() => {
    __setStorageForTest(createMemoryStorage());
  });

  it("reads ENABLED by default (fail safe, empty cache)", async () => {
    const { result } = await renderHook(() =>
      useFeatureKillSwitchActive("crash_detection"),
    );
    expect(result.current).toBe(true);
  });

  it("re-renders to false when an operator force_off is persisted while mounted", async () => {
    const { result } = await renderHook(() =>
      useFeatureKillSwitchActive("crash_detection"),
    );
    expect(result.current).toBe(true);

    // Simulate the refresh monitor persisting a fresh /config/flags map.
    await act(() => {
      setCachedSystemSwitchStates({ crash_detection: "force_off" });
    });
    expect(result.current).toBe(false);

    // And back on when the operator re-enables it.
    await act(() => {
      setCachedSystemSwitchStates({ crash_detection: "force_on" });
    });
    expect(result.current).toBe(true);
  });

  it("ignores changes to unrelated switches", async () => {
    const { result } = await renderHook(() =>
      useFeatureKillSwitchActive("crash_detection"),
    );

    await act(() => {
      setCachedSystemSwitchStates({ ride_tracking: "force_off" });
    });
    // crash_detection untouched → still enabled.
    expect(result.current).toBe(true);
  });
});
