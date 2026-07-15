import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { routes, useHashRoute } from "./routes.js";

describe("routes", () => {
  it("includes the email-templates route for support+", () => {
    const r = routes.find((x) => x.key === "email-templates");
    expect(r).toBeDefined();
    expect(r?.minRole).toBe("support");
  });
});

describe("useHashRoute", () => {
  it("parses the base key and path params from a multi-segment hash", () => {
    window.location.hash = "#/email-templates/weekly-digest/en";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.active).toBe("email-templates");
    expect(result.current.params).toEqual(["weekly-digest", "en"]);
  });

  it("yields the key and empty params for a flat route", () => {
    window.location.hash = "#/users";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.active).toBe("users");
    expect(result.current.params).toEqual([]);
  });

  it("falls back to overview for an unknown first segment", () => {
    window.location.hash = "#/bogus/x";
    const { result } = renderHook(() => useHashRoute());
    expect(result.current.active).toBe("overview");
  });
});
