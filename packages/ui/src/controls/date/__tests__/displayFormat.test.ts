import {
  displayIsoDate,
  displayIsoTime,
  displayIsoDateTime,
} from "../displayFormat";

test("displayIsoDate formats to the locale's numeric date", () => {
  expect(displayIsoDate("2026-07-15", { locale: "en-GB" })).toBe("15/07/2026");
  expect(displayIsoDate("2026-07-15", { locale: "de-DE" })).toBe("15.07.2026");
});

test("displayIsoDate anchors in UTC so the day never shifts", () => {
  // A midnight value must not roll back a day under a behind-UTC runtime zone.
  expect(displayIsoDate("2026-01-01", { locale: "en-GB" })).toBe("01/01/2026");
});

test("displayIsoDate returns empty for an empty value", () => {
  expect(displayIsoDate("")).toBe("");
});

test("displayIsoDate returns the raw string for an unparseable value", () => {
  expect(displayIsoDate("not-a-date", { locale: "en-GB" })).toBe("not-a-date");
});

test("formatValue is a full escape hatch that wins over locale", () => {
  expect(
    displayIsoDate("2026-07-15", {
      locale: "en-GB",
      formatValue: (v) => `custom:${v}`,
    }),
  ).toBe("custom:2026-07-15");
});

test("formatOptions can switch to a named-month style without throwing", () => {
  // dateStyle is mutually exclusive with the y/m/d defaults; run() must drop
  // them rather than crash.
  expect(
    displayIsoDate("2026-07-15", {
      locale: "en-GB",
      formatOptions: { dateStyle: "medium" },
    }),
  ).toBe("15 Jul 2026");
});

test("displayIsoTime shows 24h HH:MM regardless of locale default", () => {
  // en-US defaults to 12h; the helper forces hour12:false.
  expect(displayIsoTime("08:30", { locale: "en-US" })).toBe("08:30");
  expect(displayIsoTime("00:45", { locale: "en-GB" })).toBe("00:45");
});

test("displayIsoDateTime combines the locale date with 24h time", () => {
  expect(displayIsoDateTime("2026-07-15T08:30", { locale: "en-GB" })).toBe(
    "15/07/2026, 08:30",
  );
});

test("displayIsoDateTime returns empty for an empty value", () => {
  expect(displayIsoDateTime("")).toBe("");
});
