import { describe, expect, it } from "vitest";
import type { MapPoint } from "@/components/map/MapPointPopover";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";
import {
  pinnedConditionRetired,
  reconcileConditionMenu,
} from "./conditionPopoverReconcile";

const closure = (id: string, title = `Closure ${id}`): PlannerClosure =>
  ({ id, title, reason: "roadworks", severity: "full" }) as PlannerClosure;

const pass = (
  id: string,
  status: MountainPass["status"] = "closed",
): MountainPass => ({ id, name: `Pass ${id}`, status }) as MountainPass;

const closurePoint = (c: PlannerClosure): MapPoint => ({
  kind: "closure",
  closure: c,
  affectsRoute: false,
});
const passPoint = (p: MountainPass): MapPoint => ({
  kind: "pass",
  pass: p,
  affectsRoute: false,
});

const base = {
  closures: [] as PlannerClosure[],
  passes: [] as MountainPass[],
  closuresLoading: false,
  passesLoading: false,
  pinned: null,
};

describe("reconcileConditionMenu", () => {
  it("refreshes a closure that is still in the fresh list", () => {
    const stale = closure("c1", "old title");
    const fresh = closure("c1", "new title");
    const action = reconcileConditionMenu(closurePoint(stale), {
      ...base,
      closures: [fresh],
    });
    expect(action).toEqual({
      type: "refresh",
      point: { kind: "closure", closure: fresh, affectsRoute: false },
    });
  });

  it("closes a closure that the settled list no longer contains", () => {
    const action = reconcileConditionMenu(closurePoint(closure("c1")), base);
    expect(action).toEqual({ type: "close" });
  });

  it("keeps an absent closure while its list is still loading", () => {
    const action = reconcileConditionMenu(closurePoint(closure("c1")), {
      ...base,
      closuresLoading: true,
    });
    expect(action).toEqual({ type: "keep" });
  });

  it("keeps an absent closure that is the pinned row we flew to", () => {
    const action = reconcileConditionMenu(closurePoint(closure("c1")), {
      ...base,
      pinned: { kind: "closure", id: "c1" },
    });
    expect(action).toEqual({ type: "keep" });
  });

  it("closes an absent closure when the pin is a different id", () => {
    const action = reconcileConditionMenu(closurePoint(closure("c1")), {
      ...base,
      pinned: { kind: "closure", id: "c2" },
    });
    expect(action).toEqual({ type: "close" });
  });

  it("refreshes a still-present, still-closed pass", () => {
    const fresh = pass("p1", "closed");
    const action = reconcileConditionMenu(passPoint(pass("p1")), {
      ...base,
      passes: [fresh],
    });
    expect(action).toEqual({
      type: "refresh",
      point: { kind: "pass", pass: fresh, affectsRoute: false },
    });
  });

  it("refreshes a pass that is now open (explorer markers open passes too)", () => {
    const fresh = pass("p1", "open");
    const action = reconcileConditionMenu(passPoint(pass("p1", "closed")), {
      ...base,
      passes: [fresh],
    });
    expect(action).toEqual({
      type: "refresh",
      point: { kind: "pass", pass: fresh, affectsRoute: false },
    });
  });

  it("keeps an absent pass that is pinned", () => {
    const action = reconcileConditionMenu(passPoint(pass("p1")), {
      ...base,
      pinned: { kind: "pass", id: "p1" },
    });
    expect(action).toEqual({ type: "keep" });
  });

  it("leaves non-condition points (POI/hazard) untouched", () => {
    const poi = { kind: "poi", poi: { id: "x" } } as unknown as MapPoint;
    expect(reconcileConditionMenu(poi, base)).toEqual({ type: "keep" });
  });
});

describe("pinnedConditionRetired", () => {
  const settled = { closuresSettled: true, passesSettled: true };

  it("retires a pinned closure when a completed fetch still lacks it", () => {
    expect(
      pinnedConditionRetired(
        { kind: "closure", id: "c1" },
        { closures: [], passes: [], ...settled },
      ),
    ).toBe(true);
  });

  it("keeps a pinned closure that the completed fetch now contains", () => {
    expect(
      pinnedConditionRetired(
        { kind: "closure", id: "c1" },
        { closures: [closure("c1")], passes: [], ...settled },
      ),
    ).toBe(false);
  });

  it("does not retire while the fetch has not completed (no falling edge)", () => {
    expect(
      pinnedConditionRetired(
        { kind: "closure", id: "c1" },
        {
          closures: [],
          passes: [],
          closuresSettled: false,
          passesSettled: true,
        },
      ),
    ).toBe(false);
  });

  it("retires a pinned pass when a completed fetch still lacks it", () => {
    expect(
      pinnedConditionRetired(
        { kind: "pass", id: "p1" },
        { closures: [], passes: [], ...settled },
      ),
    ).toBe(true);
  });

  it("keeps a pinned pass that the completed fetch now contains", () => {
    expect(
      pinnedConditionRetired(
        { kind: "pass", id: "p1" },
        { closures: [], passes: [pass("p1")], ...settled },
      ),
    ).toBe(false);
  });
});
