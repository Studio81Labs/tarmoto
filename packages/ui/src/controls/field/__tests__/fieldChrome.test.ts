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

test("mirrors the focus ring on data-focused for react-aria triggers", () => {
  // react-aria Button triggers surface focus via data-focused, not :focus, so
  // the accent ring must be duplicated onto that variant or it never fires.
  const cls = fieldChrome();
  expect(cls).toContain("data-[focused]:border-accent");
  expect(cls).toContain("data-[focused]:ring-[3px]");
  expect(cls).toContain("data-[focused]:ring-accent/[0.18]");
});

test("error state mirrors the Q1 ring on data-focused too", () => {
  const cls = fieldChrome({ error: true });
  expect(cls).toContain("data-[focused]:border-quality-q1");
  expect(cls).toContain("data-[focused]:ring-quality-q1/[0.18]");
});
