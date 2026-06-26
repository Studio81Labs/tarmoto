export type PlacementActionId =
  | "set-start"
  | "set-end"
  | "add-via"
  | "set-new-start"
  | "set-new-end";
export interface PlacementAction {
  id: PlacementActionId;
  label: string;
}

export function buildPlacementMenu(state: {
  hasStart: boolean;
  hasEnd: boolean;
}): PlacementAction[] {
  if (!state.hasStart) return [{ id: "set-start", label: "Set start here" }];
  if (!state.hasEnd)
    return [
      { id: "set-end", label: "Set end here" },
      { id: "add-via", label: "Add via here" },
    ];
  return [
    { id: "add-via", label: "Add via here" },
    { id: "set-new-start", label: "Set as new start" },
    { id: "set-new-end", label: "Set as new end" },
  ];
}
