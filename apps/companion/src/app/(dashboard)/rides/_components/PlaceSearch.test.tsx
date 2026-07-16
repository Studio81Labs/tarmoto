import { act, fireEvent, render, screen } from "@testing-library/react";
import { PlaceSearch } from "./PlaceSearch";
import { api } from "@/lib/api";

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

  it("clearing the field drops the filter and the chip", () => {
    const onChange = vi.fn();
    render(<PlaceSearch value={{ ...PLACE, km: 25 }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
