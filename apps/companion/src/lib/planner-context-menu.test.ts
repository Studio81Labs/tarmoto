import { buildPlacementMenu } from "./planner-context-menu";

describe("buildPlacementMenu", () => {
  it("always offers start, via and end with fresh-placement ids on an empty day", () => {
    const menu = buildPlacementMenu({ hasStart: false, hasEnd: false });
    expect(menu.map((a) => a.label)).toEqual([
      "Set start here",
      "Add via here",
      "Set end here",
    ]);
    expect(menu.map((a) => a.id)).toEqual(["set-start", "add-via", "set-end"]);
  });
  it("flips to the replacing ids as start/end come to exist — labels stay put", () => {
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: false }).map((a) => a.id),
    ).toEqual(["set-new-start", "add-via", "set-end"]);
    expect(
      buildPlacementMenu({ hasStart: true, hasEnd: true }).map((a) => a.id),
    ).toEqual(["set-new-start", "add-via", "set-new-end"]);
  });
});
