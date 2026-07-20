import { makeTranslator } from "@tarmoto/shared";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SUPPORTED_LOCALES,
  resolveLocale,
  setActiveLocale,
  tDynamic,
  translate,
} from ".";
import { en, mobileCatalogs, type EnglishMessageKey } from "./locales";

describe("mobile i18n", () => {
  beforeEach(() => {
    setActiveLocale(DEFAULT_LOCALE);
  });

  it("translates registered copy and ICU values", () => {
    expect(translate("Home")).toBe("Home");
    expect(translate("Code: {code}", { code: "ABC123" })).toBe("Code: ABC123");
    expect(translate("e.g. 8f3d0c1e-...")).toBe("e.g. 8f3d0c1e-...");
    expect(
      translate("{count, plural, one {# day} other {# days}}", { count: 2 }),
    ).toBe("2 days");
    expect(
      translate("{count, plural, one {# new hazard} other {# new hazards}}", {
        count: 1,
      }),
    ).toBe("1 new hazard");
    expect(
      translate("{count, plural, one {# new hazard} other {# new hazards}}", {
        count: 2,
      }),
    ).toBe("2 new hazards");
    expect(translate("Hazards ({count})", { count: 3 })).toBe("Hazards (3)");
    expect(translate("Saved routes ({count})", { count: 2 })).toBe(
      "Saved routes (2)",
    );
    expect(translate("Members ({count})", { count: 4 })).toBe("Members (4)");
    expect(
      translate("Save current area ({distance} km)", { distance: 25 }),
    ).toBe("Save current area (25 km)");
    expect(
      translate("Below your minimum ({quality})", { quality: "Fair" }),
    ).toBe("Below your minimum (Fair)");
    expect(translate("{distance} from start", { distance: "12.0 km" })).toBe(
      "12.0 km from start",
    );
    expect(translate("{distance} km", { distance: 250 })).toBe("250 km");
    expect(
      translate(
        "{count, plural, one {# confirmation} other {# confirmations}} · {time}",
        { count: 2, time: "5m ago" },
      ),
    ).toBe("2 confirmations · 5m ago");
    expect(
      translate("{length} · {distance} from you", {
        length: "2.5 km",
        distance: "800 m",
      }),
    ).toBe("2.5 km · 800 m from you");
    expect(translate("{count} NEW", { count: 3 })).toBe("3 NEW");
    expect(translate("{min}–{max} km / day", { min: 180, max: 250 })).toBe(
      "180–250 km / day",
    );
    expect(
      translate("{distance} from the planned path — return when it's safe.", {
        distance: "120 m",
      }),
    ).toBe("120 m from the planned path — return when it's safe.");
  });

  it("keeps the deliberate dynamic-key fallback", () => {
    expect(tDynamic("runtime server copy")).toBe("runtime server copy");
  });

  it("pluralizes count-bearing labels", () => {
    expect(
      translate(
        "{severity} · {time} · {count, plural, one {# confirmation} other {# confirmations}}",
        { severity: "High", time: "5m ago", count: 1 },
      ),
    ).toBe("High · 5m ago · 1 confirmation");
    expect(
      translate(
        "{severity} · {time} · {count, plural, one {# confirmation} other {# confirmations}}",
        { severity: "High", time: "5m ago", count: 2 },
      ),
    ).toBe("High · 5m ago · 2 confirmations");
    expect(
      translate(
        "{title}, {count, plural, one {# day} other {# days}}, {status}",
        { title: "Alpine loop", count: 1, status: "Planned" },
      ),
    ).toBe("Alpine loop, 1 day, Planned");
    expect(
      translate(
        "{title}, {count, plural, one {# day} other {# days}}, {status}",
        { title: "Alpine loop", count: 3, status: "Planned" },
      ),
    ).toBe("Alpine loop, 3 days, Planned");
    expect(
      translate(
        "{count, plural, one {# segment highlighted} other {# segments highlighted}} for the selected period",
        { count: 1 },
      ),
    ).toBe("1 segment highlighted for the selected period");
    expect(
      translate("{count, plural, one {# rider} other {# riders}}", {
        count: 1,
      }),
    ).toBe("1 rider");
    expect(
      translate(
        "{count, plural, one {# follower} other {# followers}}, open list",
        { count: 1 },
      ),
    ).toBe("1 follower, open list");
    expect(
      translate(
        "Following {count, plural, one {# rider} other {# riders}}, open list",
        { count: 2 },
      ),
    ).toBe("Following 2 riders, open list");
  });

  it("re-exports the shared locale registry and resolver", () => {
    expect(SUPPORTED_LOCALES).toEqual(Object.keys(LOCALES));
    expect(resolveLocale("en-GB")).toBe("en");
  });

  it("registers a mobile catalog for every supported locale", () => {
    expect(Object.keys(mobileCatalogs).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  it("can pseudo-expand every registered key", () => {
    const pseudo = Object.fromEntries(
      Object.keys(en).map((key) => [key, `[!! ${key} !!]`]),
    ) as Record<EnglishMessageKey, string>;
    const pseudoTranslate = makeTranslator<EnglishMessageKey>({ en: pseudo });

    for (const key of Object.keys(en) as EnglishMessageKey[]) {
      expect(pseudoTranslate(key)).toBe(`[!! ${key} !!]`);
    }
  });
});
