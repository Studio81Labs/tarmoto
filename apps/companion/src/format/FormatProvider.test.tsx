import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { FormatProvider, useFormat } from "./FormatProvider";
import { usePreferencesStore } from "@/stores/preferences";

const norm = (s: string) => s.replace(/[  ]/g, " ");

function Probe() {
  const format = useFormat();
  return (
    <div>
      <span data-testid="date">{format.date("2025-04-18T22:30:00Z")}</span>
      <span data-testid="int">{format.integer(12345)}</span>
      <span data-testid="dist">{format.distanceKm(100)}</span>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <FormatProvider
      formatLocale="cs-CZ"
      timeZone="Europe/Prague"
      units="metric"
    >
      <Probe />
    </FormatProvider>,
  );
}

afterEach(() => {
  act(() => {
    usePreferencesStore.setState({ unitSystem: "metric", hydrated: false });
  });
});

describe("FormatProvider", () => {
  it("formats via the server-seeded context (locale, timezone, units)", () => {
    renderWithProvider();
    // Prague is UTC+2 on 18 Apr 22:30Z — the local day is the 19th.
    expect(norm(screen.getByTestId("date").textContent ?? "")).toBe(
      "19. 4. 2025",
    );
    expect(norm(screen.getByTestId("int").textContent ?? "")).toBe("12 345");
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");
  });

  it("keeps server-seeded units until the store hydrates, then follows it", () => {
    renderWithProvider();
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");

    act(() => {
      usePreferencesStore.setState({ unitSystem: "imperial", hydrated: true });
    });
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("62,1 mi");
  });

  it("ignores a pre-hydration store value (SSR/client first paint must agree)", () => {
    act(() => {
      usePreferencesStore.setState({ unitSystem: "imperial", hydrated: false });
    });
    renderWithProvider();
    expect(norm(screen.getByTestId("dist").textContent ?? "")).toBe("100 km");
  });
});
