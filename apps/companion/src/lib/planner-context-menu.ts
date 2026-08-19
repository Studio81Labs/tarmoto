import type { EnglishMessageKey } from "@/i18n";

export type PlacementActionId =
  "set-start" | "set-end" | "add-via" | "set-new-start" | "set-new-end";
export interface PlacementAction {
  id: PlacementActionId;
  label: EnglishMessageKey;
}

/**
 * The placement menu always offers all three roles (rider feedback) —
 * the labels stay constant; only the action ids flip to the replacing
 * variants once a start/finish already exists.
 */
export function buildPlacementMenu(state: {
  hasStart: boolean;
  hasEnd: boolean;
}): PlacementAction[] {
  return [
    {
      id: state.hasStart ? "set-new-start" : "set-start",
      label: "Set start here",
    },
    { id: "add-via", label: "Add via here" },
    { id: state.hasEnd ? "set-new-end" : "set-end", label: "Set end here" },
  ];
}
