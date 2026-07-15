import {
  parseIsoDate,
  parseIsoTime,
  parseIsoDateTime,
  isoDate,
  isoTime,
  isoDateTime,
} from "../isoDate";

test("date round-trips ISO", () => {
  expect(isoDate(parseIsoDate("2026-05-18"))).toBe("2026-05-18");
});
test("time round-trips ISO as HH:MM (seconds trimmed)", () => {
  expect(isoTime(parseIsoTime("08:30"))).toBe("08:30");
});
test("datetime round-trips ISO to minute precision", () => {
  expect(isoDateTime(parseIsoDateTime("2026-05-18T08:30"))).toBe(
    "2026-05-18T08:30",
  );
});
test("empty / invalid input parses to null and serialises to empty", () => {
  expect(parseIsoDate("")).toBeNull();
  expect(parseIsoDate("nope")).toBeNull();
  expect(isoDate(null)).toBe("");
  expect(isoTime(null)).toBe("");
});
