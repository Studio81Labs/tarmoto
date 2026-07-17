import { act, renderHook } from "@testing-library/react";
import { useDelayedLoading } from "./useDelayedLoading";

describe("useDelayedLoading", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses the spinner for loads faster than the delay", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 250),
      { initialProps: { loading: true } },
    );
    expect(result.current).toBe(false);

    // Response lands before the delay elapses — the spinner never shows.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);
  });

  it("shows the spinner once loading outlives the delay, and hides it after", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 250),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(true);

    rerender({ loading: false });
    expect(result.current).toBe(false);
  });

  it("restarts the delay for each new load", () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 250),
      { initialProps: { loading: true } },
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(true);
    rerender({ loading: false });

    // Second load: the previous timer must not leak into it.
    rerender({ loading: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);
  });
});
