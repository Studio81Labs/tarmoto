import { describe, expect, it } from "vitest";
import { t } from ".";
import {
  PASS_STATUS_LABELS,
  SEASON_LABELS,
  SUGGESTION_STATUS_LABELS,
  translateKnownLabel,
  WAYPOINT_ROLE_LABELS,
} from "./domainLabels";

describe("cataloged domain labels", () => {
  it("translates known wire values through their typed catalog key", () => {
    expect(translateKnownLabel("closed", PASS_STATUS_LABELS, t)).toBe("Closed");
    expect(translateKnownLabel("open", SUGGESTION_STATUS_LABELS, t)).toBe(
      "Open",
    );
  });

  it.each([
    ["start", "Start"],
    ["via", "Via"],
    ["end", "Finish"],
    ["finish", "Finish"],
    ["fuel", "Fuel"],
    ["rest", "Rest"],
    ["photo", "Photo"],
    ["accommodation", "Stay"],
  ])("translates the %s waypoint role", (role, expected) => {
    expect(translateKnownLabel(role, WAYPOINT_ROLE_LABELS, t)).toBe(expected);
  });

  it("hides unknown future wire values behind the cataloged fallback", () => {
    expect(translateKnownLabel("future", PASS_STATUS_LABELS, t)).toBe(
      "Unknown",
    );
  });

  it("catalogs every seasonal banner value", () => {
    expect(
      ["spring", "summer", "autumn", "winter"].map((season) =>
        translateKnownLabel(season, SEASON_LABELS, t),
      ),
    ).toEqual(["Spring", "Summer", "Autumn", "Winter"]);
  });
});
