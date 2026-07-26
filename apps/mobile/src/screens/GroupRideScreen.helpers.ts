import { translate, type EnglishMessageKey, type Translate } from "@/i18n";

const TERMINAL_GROUP_RIDE_ERROR_KEYS = {
  "Group ride has ended": "Group ride has ended",
  "Group ride not found or access denied":
    "Group ride not found or access denied",
} as const satisfies Record<string, EnglishMessageKey>;

type TerminalGroupRideError = keyof typeof TERMINAL_GROUP_RIDE_ERROR_KEYS;

export interface GroupRideErrorPresentation {
  displayText: string;
  terminal: boolean;
}

/**
 * Keep gateway diagnostics out of rider-facing copy. Known terminal messages
 * retain their specific behavior; every other server/socket message collapses
 * to one cataloged transient fallback.
 */
export function resolveGroupRideError(
  message: string,
  t: Translate = translate,
): GroupRideErrorPresentation {
  if (Object.hasOwn(TERMINAL_GROUP_RIDE_ERROR_KEYS, message)) {
    return {
      displayText: t(
        TERMINAL_GROUP_RIDE_ERROR_KEYS[message as TerminalGroupRideError],
      ),
      terminal: true,
    };
  }
  return {
    displayText: t("The live group ride connection had a problem. Try again."),
    terminal: false,
  };
}
