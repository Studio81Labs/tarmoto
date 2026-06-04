import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNumberFormat } from "./useNumberFormat";

describe("useNumberFormat", () => {
  it("formats numbers with locale grouping and decimals", () => {
    const { result } = renderHook(() => useNumberFormat());
    // No I18nProvider → the default locale (en) drives Intl formatting.
    expect(result.current.locale).toBe("en");
    expect(result.current.format(12643.8)).toBe("12,643.8");
    expect(result.current.format(847)).toBe("847");
  });

  it("honours Intl.NumberFormat options (fixed fraction digits)", () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(
      result.current.format(4, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    ).toBe("4.0");
  });
});
