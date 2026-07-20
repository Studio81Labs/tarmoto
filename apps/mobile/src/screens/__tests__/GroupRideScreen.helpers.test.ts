import { translateTerminalGroupRideError } from "../GroupRideScreen.helpers";
import type { Translate } from "@/i18n";

describe("translateTerminalGroupRideError", () => {
  const translate: Translate = (key) => `translated:${key}`;

  it.each([
    "Group ride has ended",
    "Group ride not found or access denied",
  ] as const)("catalogs the terminal gateway message: %s", (message) => {
    expect(translateTerminalGroupRideError(message, translate)).toBe(
      `translated:${message}`,
    );
  });

  it("leaves unknown transient errors available for the inline banner", () => {
    expect(
      translateTerminalGroupRideError("Rate limit exceeded", translate),
    ).toBeNull();
  });
});
