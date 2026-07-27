import { SUPPORTED_LOCALES } from "@tarmoto/shared";
import {
  emergencyCatalogs,
  getEmergencyCopy,
  resolveEmergencyLocale,
} from "./emergency-copy";

describe("root emergency localization", () => {
  it("ships independent emergency copy for every registered locale", () => {
    expect(Object.keys(emergencyCatalogs).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it("matches regional browser locales and safely falls back", () => {
    expect(resolveEmergencyLocale(["en-GB"])).toBe("en");
    expect(resolveEmergencyLocale(["xx", null])).toBe("en");
    expect(getEmergencyCopy("en").reload).toBe("Reload page");
  });
});
