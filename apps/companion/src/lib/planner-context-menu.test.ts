import { buildPlacementMenu } from "./planner-context-menu";

describe("buildPlacementMenu", () => {
  it("offers only Set start when there is no start", () => {
    expect(
      buildPlacementMenu({ hasStart: false, hasEnd: false }).map((a) => a.id),
    ).toEqual(["set-start"]);
  });
  it("offers Set end + Add via when start exists but no end", () => {
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: false }).map((a) => a.id),
    ).toEqual(["set-end", "add-via"]);
  });
  it("offers Add via + replace start/end when both exist", () => {
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: true }).map((a) => a.id),
    ).toEqual(["add-via", "set-new-start", "set-new-end"]);
  });
});
