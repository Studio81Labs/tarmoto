import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getMock = vi.fn();
vi.mock("@/lib/api/server", () => ({
  apiServer: { GET: (...a: unknown[]) => getMock(...a) },
}));
// React `cache()` memoizes per REQUEST; outside a request there is nothing to
// scope to, so unwrap it and let each case drive the fetch directly. The
// dedupe itself is React's, not ours, and is not what these cases are about.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

import {
  getServerFlagStates,
  serverKillSwitch,
  serverSystemSwitch,
} from "./serverFlags";

const ok = (data: Record<string, string>) => ({
  data,
  response: { ok: true, status: 200 },
});

describe("serverFlags", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getMock.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("reports a confirmed force_off as disabled", async () => {
    getMock.mockResolvedValue(ok({ road_quality_overlay: "force_off" }));
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(false);
  });

  it("reports an absent key as enabled", async () => {
    getMock.mockResolvedValue(ok({}));
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(true);
    await expect(serverSystemSwitch("sys_poi_ratings")).resolves.toBe(true);
  });

  it("treats force_on as enabled", async () => {
    getMock.mockResolvedValue(ok({ road_quality_overlay: "force_on" }));
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(true);
  });

  it("resolves system switches from the same map", async () => {
    getMock.mockResolvedValue(ok({ sys_poi_ratings: "force_off" }));
    await expect(serverSystemSwitch("sys_poi_ratings")).resolves.toBe(false);
    // One key's kill does not bleed into another's answer.
    await expect(serverSystemSwitch("sys_gamification")).resolves.toBe(true);
  });

  it("fails SAFE and WARNS on a non-ok response", async () => {
    getMock.mockResolvedValue({
      data: null,
      response: { ok: false, status: 503 },
    });
    // A flags outage must not blank public pages — that turns a backend blip
    // into a site-wide content outage.
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("503"));
  });

  it("fails SAFE and WARNS on a thrown error", async () => {
    getMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("distinguishes a TIMEOUT from a network failure in the warning", async () => {
    // Different causes point an operator at different things — a slow backend
    // versus an unreachable one — so the log has to tell them apart.
    getMock.mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    await expect(serverKillSwitch("road_quality_overlay")).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("never fails silently — every failure path logs", async () => {
    // The fail-safe direction means a killed surface KEEPS SERVING during an
    // outage. An operator who flips a switch has to be able to tell it did not
    // take effect, so silence here is the actual defect.
    getMock.mockResolvedValue({
      data: null,
      response: { ok: true, status: 200 },
    });
    await expect(getServerFlagStates()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sends the request with a bounded timeout", async () => {
    getMock.mockResolvedValue(ok({}));
    await getServerFlagStates();
    expect(getMock).toHaveBeenCalledWith(
      "/api/v1/config/flags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
