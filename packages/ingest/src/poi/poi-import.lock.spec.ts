import { poiAdvisoryLockKey } from "./poi-import.lock.js";

describe("poiAdvisoryLockKey", () => {
  const INT32_MIN = -(2 ** 31);
  const INT32_MAX = 2 ** 31 - 1;

  it("produces distinct keys for (osm, CZ) / (fsq, CZ) / (osm, SK) / (fsq, SK) — no cross-source or cross-region collision", () => {
    const keys = [
      poiAdvisoryLockKey("osm", "CZ"),
      poiAdvisoryLockKey("fsq", "CZ"),
      poiAdvisoryLockKey("osm", "SK"),
      poiAdvisoryLockKey("fsq", "SK"),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("always returns a 32-bit-range integer, matching pg_try_advisory_lock(int, int)", () => {
    const keys = [
      poiAdvisoryLockKey("osm", "CZ"),
      poiAdvisoryLockKey("fsq", "CZ"),
      poiAdvisoryLockKey("osm", "SK"),
      poiAdvisoryLockKey("fsq", "SK"),
    ];

    for (const key of keys) {
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(INT32_MIN);
      expect(key).toBeLessThanOrEqual(INT32_MAX);
    }
  });

  it("is deterministic for the same (source, code) pair", () => {
    expect(poiAdvisoryLockKey("osm", "CZ")).toBe(
      poiAdvisoryLockKey("osm", "CZ"),
    );
  });
});
