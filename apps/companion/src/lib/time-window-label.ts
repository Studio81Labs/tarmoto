import type { Translate } from "@/i18n";

export type CommonTimeWindow = "all" | "year" | "90d" | "30d";

/** Render shared ride/exploration windows without embedding regional digits. */
export function timeWindowLabel(
  window: CommonTimeWindow,
  t: Translate,
): string {
  switch (window) {
    case "all":
      return t("All time");
    case "year":
      return t("This year");
    case "90d":
      return t("Last {count, plural, one {# day} other {# days}}", {
        count: 90,
      });
    case "30d":
      return t("Last {count, plural, one {# day} other {# days}}", {
        count: 30,
      });
  }
}
