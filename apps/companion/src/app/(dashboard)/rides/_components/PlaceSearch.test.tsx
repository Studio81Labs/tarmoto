import { act, fireEvent, render, screen } from "@testing-library/react";
import { PlaceSearch } from "./PlaceSearch";
import { api } from "@/lib/api";
import { FormatProvider } from "@/format/FormatProvider";

vi.mock("@/lib/api", () => ({
  api: { GET: vi.fn() },
}));

// The radius popover embeds a MapLibre preview; stub it so jsdom never
// touches WebGL. The lat/lng/km props are asserted through the stub.
vi.mock("@/components/map/RadiusPreviewMap", () => ({
  RadiusPreviewMap: ({ km }: { km: number }) => (
    <div data-testid="radius-preview-map" data-km={km} />
  ),
}));

const PLACE = {
  label: "Tatra Mountains, Slovakia",
  lat: 49.17,
  lng: 20.13,
};

describe("PlaceSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.GET).mockResolvedValue({
      data: { results: [PLACE] },
      error: undefined,
    } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("geocodes the typed query and reports the picked place with the default radius", async () => {
    const onChange = vi.fn();
    render(<PlaceSearch value={null} onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "tatra" },
    });
    // Debounce + resolved fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    fireEvent.click(
      screen.getByRole("option", { name: "Tatra Mountains, Slovakia" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      label: PLACE.label,
      lat: PLACE.lat,
      lng: PLACE.lng,
      km: 25,
    });
  });

  it("suppresses the previous query's matches during the debounce gap", async () => {
    render(<PlaceSearch value={null} onChange={vi.fn()} />);

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "tatra" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(
      screen.getByRole("option", { name: "Tatra Mountains, Slovakia" }),
    ).toBeVisible();

    // A new draft immediately flips to the loading row — the old query's
    // results must not be visible (or keyboard-selectable) while the new
    // request hasn't even been debounced yet.
    fireEvent.change(input, { target: { value: "brno" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("Searching…")).toBeVisible();
  });

  it("shows the radius as an in-field chip and changes it via the popover", () => {
    const onChange = vi.fn();
    render(<PlaceSearch value={{ ...PLACE, km: 25 }} onChange={onChange} />);

    // No always-visible radius row anymore — the value lives in the chip.
    const chip = screen.getByRole("button", { name: "Search radius: 25 km" });
    expect(chip).toHaveTextContent("25 km");
    expect(chip).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    // Popover: segmented radius options + the map preview stub.
    fireEvent.click(screen.getByRole("radio", { name: "50 km" }));
    expect(onChange).toHaveBeenCalledWith({ ...PLACE, km: 50 });
  });

  it("uses the displayed imperial distance in the radius accessible name", () => {
    render(
      <FormatProvider formatLocale="en-US" timeZone="UTC" units="imperial">
        <PlaceSearch value={{ ...PLACE, km: 25 }} onChange={vi.fn()} />
      </FormatProvider>,
    );

    const chip = screen.getByRole("button", {
      name: "Search radius: 15.5 mi",
    });
    expect(chip).toHaveTextContent("15.5 mi");
  });

  it("clearing the field drops the filter and the chip", () => {
    const onChange = vi.fn();
    render(<PlaceSearch value={{ ...PLACE, km: 25 }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("closes the radius popover when focus leaves the control or on Escape", async () => {
    vi.useRealTimers();
    const { default: userEvent } = await import("@testing-library/user-event");
    render(
      <>
        <PlaceSearch value={{ ...PLACE, km: 25 }} onChange={vi.fn()} />
        <button type="button">Next filter</button>
      </>,
    );
    const chip = screen.getByRole("button", { name: "Search radius: 25 km" });

    // Tab out: walk the control's stops (clear ✕, radius radio, …) until
    // focus lands on the next filter — the exact count isn't the contract.
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const next = screen.getByRole("button", { name: "Next filter" });
    for (let i = 0; i < 6 && document.activeElement !== next; i++) {
      await userEvent.tab();
    }
    expect(next).toHaveFocus();
    expect(chip).toHaveAttribute("aria-expanded", "false");

    // Escape while inside the control.
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the clear action reachable after the rider erases the text", () => {
    const onChange = vi.fn();
    render(<PlaceSearch value={{ ...PLACE, km: 25 }} onChange={onChange} />);

    // Erase the label — the near-filter (and its chip) are still applied,
    // so the ✕ must survive to drop them.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
