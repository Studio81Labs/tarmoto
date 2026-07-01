import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mutable nav state shared by the mocks below.
const navState = {
  pathname: "/rides",
  search: new URLSearchParams(),
};
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => navState.search,
}));

import { RidesTabsBar } from "./_RidesTabsBar";

function setNav(pathname: string, search = "") {
  navState.pathname = pathname;
  navState.search = new URLSearchParams(search);
}

describe("RidesTabsBar — window preserved across tabs", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    setNav("/rides");
  });

  it("carries the active ?window= onto every tab href", () => {
    setNav("/rides", "window=30d");
    render(<RidesTabsBar />);
    const hrefOf = (name: RegExp) =>
      screen.getByRole("link", { name }).getAttribute("href");
    expect(hrefOf(/All rides/)).toBe("/rides?window=30d");
    expect(hrefOf(/Road map/)).toBe("/rides/road-map?window=30d");
    expect(hrefOf(/Compare rides/)).toBe("/rides/compare?window=30d");
  });

  it("uses bare hrefs when the window is 'all' (default, param omitted)", () => {
    setNav("/rides");
    render(<RidesTabsBar />);
    expect(
      screen.getByRole("link", { name: /Road map/ }).getAttribute("href"),
    ).toBe("/rides/road-map");
  });

  it("keeps the All-rides tab active on /rides despite the query in its href", () => {
    setNav("/rides", "window=90d");
    render(<RidesTabsBar />);
    // matchPrefixes keeps the active check on the bare pathname.
    expect(screen.getByRole("link", { name: /All rides/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides the time-window pills on the Compare tab", () => {
    setNav("/rides/compare", "window=30d");
    render(<RidesTabsBar />);
    // "Last 30 days" pill (a SegmentedControl radio) only renders when shown.
    expect(screen.queryByRole("radio", { name: "Last 30 days" })).toBeNull();
  });
});

describe("TimeWindowPills — pagination reset on window change", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    setNav("/rides");
  });

  it("drops the stale page offset when the window changes", () => {
    setNav("/rides", "page=4&type=trip");
    render(<RidesTabsBar />);
    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const replaceCall = mockReplace.mock.calls[0];
    if (!replaceCall) throw new Error("expected replace to have been called");
    const url = replaceCall[0] as string;
    expect(url).toContain("window=30d");
    expect(url).toContain("type=trip"); // other filters preserved
    expect(url).not.toContain("page="); // pagination reset
  });
});
