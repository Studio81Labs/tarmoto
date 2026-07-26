import { resolveGroupRideError } from "../GroupRideScreen.helpers";
import type { Translate } from "@/i18n";

describe("resolveGroupRideError", () => {
  const translate: Translate = (key) => `translated:${key}`;

  it.each([
    "Group ride has ended",
    "Group ride not found or access denied",
  ] as const)("catalogs the terminal gateway message: %s", (message) => {
    expect(resolveGroupRideError(message, translate)).toEqual({
      displayText: `translated:${message}`,
      terminal: true,
    });
  });

  it("does not expose unknown gateway diagnostics in the inline banner", () => {
    expect(resolveGroupRideError("Rate limit exceeded", translate)).toEqual({
      displayText:
        "translated:The live group ride connection had a problem. Try again.",
      terminal: false,
    });
  });
});
