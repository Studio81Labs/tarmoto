import { fieldChrome } from "../fieldChrome";

test("defaults to paper surface with the strong hairline border", () => {
  const cls = fieldChrome();
  expect(cls).toContain("bg-paper");
  expect(cls).toContain("border-line-strong");
});

test("cream tone swaps the surface", () => {
  expect(fieldChrome({ tone: "cream" })).toContain("bg-cream");
});

test("error state uses the Q1 border, not the accent focus border", () => {
  const cls = fieldChrome({ error: true });
  expect(cls).toContain("border-quality-q1");
});

test("leading and trailing add padding hooks", () => {
  const cls = fieldChrome({ hasLeading: true, hasTrailing: true });
  expect(cls).toContain("pl-9");
  expect(cls).toContain("pr-9");
});

test("disabled marks the not-allowed affordance", () => {
  expect(fieldChrome({ disabled: true })).toContain("cursor-not-allowed");
});
