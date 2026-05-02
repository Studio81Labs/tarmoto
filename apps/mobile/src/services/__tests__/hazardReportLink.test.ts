/**
 * Coverage for the hazard-report deep-link helpers (US-17 follow-up
 * / #343). The parser sits between React Navigation's linking layer
 * and the HazardReport screen: any value that survives must be a
 * canonical hazard type the screen / shared types recognise.
 *
 * The Google Assistant App Action's inline inventory in
 * `android/app/src/main/res/xml/shortcuts.xml` mirrors
 * `HAZARD_TYPES` from `@tarmoto/shared`; this test pins both the
 * happy path (every canonical type round-trips) and the rejection
 * path (anything else collapses to `undefined` so the screen falls
 * back to the no-preselection behaviour).
 */

import { HAZARD_TYPES } from "@tarmoto/shared";
import { parseHazardTypeParam } from "../hazardReportLink";

describe("parseHazardTypeParam", () => {
  it("returns each canonical hazard type unchanged", () => {
    for (const type of HAZARD_TYPES) {
      expect(parseHazardTypeParam(type)).toBe(type);
    }
  });

  it("normalises whitespace and casing variations the Assistant may emit", () => {
    expect(parseHazardTypeParam("Pothole")).toBe("pothole");
    expect(parseHazardTypeParam("  GRAVEL  ")).toBe("gravel");
    expect(parseHazardTypeParam("Oil_Spill")).toBe("oil_spill");
  });

  it("rejects synonyms that aren't canonical hazard types", () => {
    // The Assistant inventory matches "potholes" / "hole" against the
    // pothole synonym list and emits `pothole` (the canonical bound
    // value); if a misconfigured client ever sends the raw synonym
    // through, the parser should fail closed rather than mint a
    // brand-new "potholes" hazard type the rest of the app can't
    // render.
    expect(parseHazardTypeParam("potholes")).toBeUndefined();
    expect(parseHazardTypeParam("oil spill")).toBeUndefined();
    expect(parseHazardTypeParam("speed trap")).toBeUndefined();
  });

  it("rejects empty / whitespace / undefined inputs", () => {
    expect(parseHazardTypeParam(undefined)).toBeUndefined();
    expect(parseHazardTypeParam("")).toBeUndefined();
    expect(parseHazardTypeParam("   ")).toBeUndefined();
  });

  it("rejects arbitrary strings", () => {
    expect(parseHazardTypeParam("nonsense")).toBeUndefined();
    expect(parseHazardTypeParam("<script>")).toBeUndefined();
    expect(parseHazardTypeParam("../etc/passwd")).toBeUndefined();
  });
});
