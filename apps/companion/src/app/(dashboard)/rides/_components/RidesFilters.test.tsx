import { act, fireEvent, render, screen } from "@testing-library/react";
import { RidesFilters } from "./RidesFilters";
import type { RidesQueryState } from "./useRidesQuery";

// `road_quality_overlay` gates the quality column/tile/filter; the real hook
// needs a QueryClientProvider these suites do not render. Keyed so a case that
// kills one switch cannot silently flip another.
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

// PlaceSearch (rendered by RidesFilters) pulls the API client for its
// geocode lookups; stub it so rendering never reaches the network layer.
vi.mock("@/lib/api", () => ({
  api: { GET: vi.fn() },
}));

const baseState: RidesQueryState = {
  sort: "started_at",
  order: "desc",
  page: 1,
};

describe("RidesFilters distance drafts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a decimal km value and commits it after the debounce", () => {
    const update = vi.fn();
    render(<RidesFilters state={baseState} update={update} reset={vi.fn()} />);

    const minKm = screen.getByLabelText("Min km");
    fireEvent.change(minKm, { target: { value: "12.5" } });
    expect(minKm).toHaveValue("12.5");

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(update).toHaveBeenCalledWith({ minDistance: 12.5 });
  });

  it("holds a trailing-dot draft instead of committing a rewritten value", () => {
    const update = vi.fn();
    render(<RidesFilters state={baseState} update={update} reset={vi.fn()} />);

    const minKm = screen.getByLabelText("Min km");
    fireEvent.change(minKm, { target: { value: "12." } });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    // "12." is a decimal mid-entry — committing 12 would round-trip the
    // URL and eat the separator under the rider's cursor.
    expect(update).not.toHaveBeenCalled();
    expect(minKm).toHaveValue("12.");

    fireEvent.change(minKm, { target: { value: "12.5" } });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(update).toHaveBeenCalledWith({ minDistance: 12.5 });
  });

  it("drops a second decimal separator from the draft", () => {
    render(<RidesFilters state={baseState} update={vi.fn()} reset={vi.fn()} />);

    const maxKm = screen.getByLabelText("Max km");
    fireEvent.change(maxKm, { target: { value: "12.5.5" } });
    expect(maxKm).toHaveValue("12.55");
  });

  it("reset cancels a pending distance commit instead of re-applying it", () => {
    const update = vi.fn();
    const reset = vi.fn();
    // `type` makes a filter active so the reset button renders.
    render(
      <RidesFilters
        state={{ ...baseState, type: "trip" }}
        update={update}
        reset={reset}
      />,
    );

    fireEvent.change(screen.getByLabelText("Min km"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(reset).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(350);
    });
    // Without draft clearing, the still-pending debounce would fire
    // update({ minDistance: 150 }) here and resurrect the filter the
    // rider just cleared.
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Min km")).toHaveValue("");
  });
});

describe("RidesFilters — road_quality_overlay", () => {
  it("drops the min/max quality control pair under the kill", () => {
    killSwitches.road_quality_overlay = true;
    const { unmount } = render(
      <RidesFilters state={baseState} update={vi.fn()} reset={vi.fn()} />,
    );
    expect(screen.getByLabelText("Min quality")).toBeInTheDocument();
    unmount();

    killSwitches.road_quality_overlay = false;
    render(<RidesFilters state={baseState} update={vi.fn()} reset={vi.fn()} />);
    // The pair goes together — its only axis is the killed dimension, and
    // `useRidesQuery` already refuses the `minQ`/`maxQ` it would set.
    expect(screen.queryByLabelText("Min quality")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max quality")).not.toBeInTheDocument();
  });
});
