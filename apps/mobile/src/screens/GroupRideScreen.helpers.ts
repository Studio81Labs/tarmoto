import { translate, type EnglishMessageKey, type Translate } from "@/i18n";

const TERMINAL_GROUP_RIDE_ERROR_KEYS = {
  "Group ride has ended": "Group ride has ended",
  "Group ride not found or access denied":
    "Group ride not found or access denied",
} as const satisfies Record<string, EnglishMessageKey>;

type TerminalGroupRideError = keyof typeof TERMINAL_GROUP_RIDE_ERROR_KEYS;

/** Translate fixed terminal gateway errors; unknown errors remain inline. */
export function translateTerminalGroupRideError(
  message: string,
  t: Translate = translate,
): string | null {
  if (!Object.hasOwn(TERMINAL_GROUP_RIDE_ERROR_KEYS, message)) return null;
  return t(TERMINAL_GROUP_RIDE_ERROR_KEYS[message as TerminalGroupRideError]);
}
