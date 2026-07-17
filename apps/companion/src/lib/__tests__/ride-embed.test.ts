import { createFormatters } from "@tarmoto/shared";
import {
  buildRideEmbedUrl,
  buildRideIframeCode,
  formatRideEmbedStat,
} from "../ride-embed";

// Deterministic en/UTC/metric context — mirrors the component-test default
// (no FormatProvider) so lib-level assertions stay locale-neutral.
const format = createFormatters({ locale: "en", units: "metric" });

describe("ride-embed", () => {
  it("builds the route widget url for a shared ride token", () => {
    expect(
      buildRideEmbedUrl("https://tarmoto.app/", {
        token: "abc123",
        variant: "compact",
      }),
    ).toBe("https://tarmoto.app/embed/rides/abc123?variant=compact");
  });

  it("creates a responsive iframe snippet for the public shared ride widget", () => {
    const snippet = buildRideIframeCode("https://tarmoto.app", {
      token: "abc123",
      rideLabel: 'John Rider "Sunday blast"',
      variant: "landscape",
    });

    expect(snippet).toContain("<iframe");
    expect(snippet).toContain(
      'src="https://tarmoto.app/embed/rides/abc123?variant=landscape"',
    );
    expect(snippet).toContain(
      'title="Tarmoto route widget for John Rider &quot;Sunday blast&quot;"',
    );
    expect(snippet).toContain("height:520px");
  });

  it("formats compact analytics stats for the embed panel", () => {
    expect(formatRideEmbedStat(1, "view", format)).toBe("1 view");
    expect(formatRideEmbedStat(2450, "click", format)).toBe("2,450 clicks");
  });
});
