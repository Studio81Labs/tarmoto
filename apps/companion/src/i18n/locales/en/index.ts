import { achievements } from "./achievements";
import { auth } from "./auth";
import { common } from "./common";
import { community } from "./community";
import { map } from "./map";
import { rides } from "./rides";
import { settings } from "./settings";
import { trips } from "./trips";

// English source catalog, split by domain. Keys are the English source
// text (key === value). `EnglishMessageKey` is the union PR 3b's typed
// `t()` enforces. A new key goes in the domain module it is used from,
// or `common` if it is shared across domains.
export const en = {
  ...achievements,
  ...auth,
  ...common,
  ...community,
  ...map,
  ...rides,
  ...settings,
  ...trips,
} as const;

export type EnglishMessageKey = keyof typeof en;

/** Every domain module, for the cross-module duplicate-key test. */
export const __catalogModules = {
  achievements,
  auth,
  common,
  community,
  map,
  rides,
  settings,
  trips,
} as const;
