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
  // en-US defaults to 12h; the helper forces the h23 cycle.
  expect(displayIsoTime("08:30", { locale: "en-US" })).toBe("08:30");
  expect(displayIsoTime("00:45", { locale: "en-GB" })).toBe("00:45");
  // Midnight must be 00:xx, not 24:xx (h24 is what hour12:false yields on en-US).
  expect(displayIsoTime("00:45", { locale: "en-US" })).toBe("00:45");
  expect(displayIsoTime("00:00", { locale: "en-US" })).toBe("00:00");
});

test("defers runtime-locale formatting until hydration (SSR-safe default)", () => {
  // No explicit locale + not hydrated → raw ISO, so server and first client
  // paint agree.
  expect(displayIsoDate("2026-07-15", { hydrated: false })).toBe("2026-07-15");
  expect(displayIsoTime("08:30", { hydrated: false })).toBe("08:30");
  expect(displayIsoDateTime("2026-07-15T08:30", { hydrated: false })).toBe(
    "2026-07-15T08:30",
  );
  // Explicit locale is deterministic → formats even before hydration.
  expect(
    displayIsoDate("2026-07-15", { locale: "en-GB", hydrated: false }),
  ).toBe("15/07/2026");
  // formatValue is deterministic too.
  expect(
    displayIsoDate("2026-07-15", { hydrated: false, formatValue: () => "x" }),
  ).toBe("x");
  // Once hydrated, the runtime-locale path formats.
  expect(
    displayIsoDate("2026-07-15", { locale: "en-GB", hydrated: true }),
  ).toBe("15/07/2026");
});

test("style options keep 24h time (hourCycle survives the field-default drop)", () => {
  // timeStyle drops the y/m/d/h/m field defaults but must retain h23, or en-US
  // regresses to 12h.
  const t = displayIsoTime("13:30", {
    locale: "en-US",
    formatOptions: { timeStyle: "short" },
  });
  expect(t).not.toMatch(/[ap]m/i);
  expect(t).toMatch(/13/);

  const midnight = displayIsoTime("00:45", {
    locale: "en-US",
    formatOptions: { timeStyle: "short" },
  });
  expect(midnight).not.toMatch(/[ap]m/i);
  expect(midnight).toMatch(/^00?[:.]45/);

  const dt = displayIsoDateTime("2026-07-15T13:30", {
    locale: "en-US",
    formatOptions: { dateStyle: "short", timeStyle: "short" },
  });
  expect(dt).not.toMatch(/[ap]m/i);
  expect(dt).toMatch(/13/);
});

test("caller's hour12:false stays 24h (normalized to h23) on en-US", () => {
  expect(
    displayIsoTime("00:45", {
      locale: "en-US",
      formatOptions: { hour12: false },
    }),
  ).toBe("00:45");
  expect(
    displayIsoDateTime("2026-07-15T00:45", {
      locale: "en-GB",
      formatOptions: { hour12: false },
    }),
  ).toBe("15/07/2026, 00:45");
});

test("explicit hour12:true remains a deliberate 12h override", () => {
  const out = displayIsoTime("13:30", {
    locale: "en-US",
    formatOptions: { hour12: true },
  });
  expect(out).toMatch(/[ap]m/i);
});

test("displayIsoDateTime combines the locale date with 24h time", () => {
  expect(displayIsoDateTime("2026-07-15T08:30", { locale: "en-GB" })).toBe(
    "15/07/2026, 08:30",
  );
});

test("displayIsoDateTime returns empty for an empty value", () => {
  expect(displayIsoDateTime("")).toBe("");
});
