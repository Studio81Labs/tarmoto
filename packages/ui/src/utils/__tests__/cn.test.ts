import { cn } from "../cn";

test("composes conditional classes like clsx", () => {
  expect(cn("a", false && "b", "c")).toBe("a c");
});

test("a caller class overrides a conflicting base utility (tailwind-merge)", () => {
  // The Select/Combobox root uses `cn('relative w-full', className)`; a caller
  // passing a narrower width must win so flex filter layouts stay compact.
  expect(cn("relative w-full", "w-auto shrink-0")).toBe(
    "relative w-auto shrink-0",
  );
  expect(cn("w-full", "w-36")).toBe("w-36");
});

test("keeps non-conflicting classes untouched", () => {
  expect(cn("relative w-full", "shrink-0")).toBe("relative w-full shrink-0");
});
