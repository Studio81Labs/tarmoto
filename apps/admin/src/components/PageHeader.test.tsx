import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PageHeader as UiPageHeader } from "@tarmoto/ui";
import { PageHeader } from "./PageHeader.js";

/**
 * The shared PageHeader only mounts its condensed bar once an
 * IntersectionObserver reports the header has scrolled out of view. jsdom has
 * no IntersectionObserver, so the bar never appears here on its own — a plain
 * "the bar is absent" assertion would pass even with sticky left on. This fake
 * hands back the trigger so the test can actually scroll the header away.
 */
let scrollHeaderAway: (() => void) | null = null;

function stubIntersectionObserver() {
  class FakeIntersectionObserver {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      scrollHeaderAway = () => callback([{ isIntersecting: false }]);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
}

afterEach(() => {
  vi.unstubAllGlobals();
  scrollHeaderAway = null;
});

describe("admin PageHeader", () => {
  it("does not pin a condensed bar when the header scrolls away", () => {
    stubIntersectionObserver();
    render(<PageHeader title="Users" />);

    act(() => scrollHeaderAway?.());

    // Only the real heading — no second, condensed copy of the title.
    expect(screen.getAllByText("Users")).toHaveLength(1);
  });

  it("still passes an explicit sticky through to the shared component", () => {
    stubIntersectionObserver();
    render(<PageHeader title="Users" sticky />);

    act(() => scrollHeaderAway?.());

    expect(screen.getAllByText("Users")).toHaveLength(2);
  });

  it("confirms the shared component would pin the bar (the behaviour being disabled)", () => {
    stubIntersectionObserver();
    render(<UiPageHeader title="Users" />);

    act(() => scrollHeaderAway?.());

    expect(screen.getAllByText("Users")).toHaveLength(2);
  });

  it("renders the title, sub and actions like the shared component", () => {
    render(
      <PageHeader
        title="POI Imports"
        sub="Coverage and manual triggers."
        right={<button type="button">Refresh</button>}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "POI Imports" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Coverage and manual triggers."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
