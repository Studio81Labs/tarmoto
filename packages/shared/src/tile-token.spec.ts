import { tileTokenRotationMs } from "./tile-token";

describe("tileTokenRotationMs", () => {
  it("rotates before the server expiry rather than at it", () => {
    // The 15-minute server TTL rotates at 9 minutes, so the replacement is in
    // hand well before tiles would start being fetched anonymously.
    expect(tileTokenRotationMs(900)).toBe(540_000);
  });

  it("never rotates faster than every 30 s", () => {
    // Guards against a short server TTL turning a map into a mint loop.
    expect(tileTokenRotationMs(10)).toBe(30_000);
    expect(tileTokenRotationMs(0)).toBe(30_000);
  });

  it("returns whole milliseconds", () => {
    expect(Number.isInteger(tileTokenRotationMs(901))).toBe(true);
  });
});
