import { fireEvent, render, screen } from "@testing-library/react";
import { RoundtripDialog } from "./RoundtripDialog";

describe("RoundtripDialog", () => {
  it("re-seeds its options on every open — never confirms stale state", () => {
    const onConfirm = vi.fn();
    const noop = vi.fn();
    const { rerender } = render(
      <RoundtripDialog
        open={false}
        defaultPreference="direct"
        hasRegion={false}
        drafting={false}
        onClose={noop}
        onConfirm={onConfirm}
      />,
    );

    // The trip-wide preference changes while the dialog is closed…
    rerender(
      <RoundtripDialog
        open
        defaultPreference="maximum_twisty"
        initialDistanceKm={400}
        initialDirection="NE"
        hasRegion={false}
        drafting={false}
        onClose={noop}
        onConfirm={onConfirm}
      />,
    );

    // …and opening reflects the CURRENT inputs, not the first mount's.
    fireEvent.click(screen.getByRole("button", { name: /^Draft roundtrip$/i }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        preference: "maximum_twisty",
        distanceKm: 400,
        direction: "NE",
      }),
    );
  });
});
