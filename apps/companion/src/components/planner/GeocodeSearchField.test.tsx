import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GeocodeSearchField } from "./GeocodeSearchField";
import { plannerApi } from "@/lib/planner/api";

vi.mock("@/lib/planner/api", () => ({
  plannerApi: { geocode: vi.fn() },
}));

const geocodeMock = vi.mocked(plannerApi.geocode);

describe("GeocodeSearchField", () => {
  beforeEach(() => {
    geocodeMock.mockReset();
  });

  it("searches (debounced) and offers a dropdown of matches", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Praha", lat: 50.0755, lng: 14.4378 },
      { name: "Pardubice", lat: 50.0343, lng: 15.7812 },
    ]);
    render(
      <GeocodeSearchField
        placeholder="Search"
        ariaLabel="Search start"
        onSelect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search start"), {
      target: { value: "pra" },
    });
    expect(await screen.findByText("Praha")).toBeInTheDocument();
    expect(screen.getByText("Pardubice")).toBeInTheDocument();
    await waitFor(() => expect(geocodeMock).toHaveBeenCalledWith("pra"));
  });

  it("fires onSelect with the picked result and closes the dropdown", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Split", lat: 43.5081, lng: 16.4402 },
    ]);
    const onSelect = vi.fn();
    render(
      <GeocodeSearchField
        placeholder="Search"
        ariaLabel="Search finish"
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search finish"), {
      target: { value: "spl" },
    });
    fireEvent.click(await screen.findByText("Split"));

    expect(onSelect).toHaveBeenCalledWith({
      name: "Split",
      lat: 43.5081,
      lng: 16.4402,
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The picked name lands in the input (relocate mode).
    expect(screen.getByLabelText("Search finish")).toHaveValue("Split");
  });

  it("clears after a pick in add-via mode", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Zagreb", lat: 45.815, lng: 15.9819 },
    ]);
    render(
      <GeocodeSearchField
        placeholder="Add via"
        ariaLabel="Search via"
        onSelect={vi.fn()}
        clearOnSelect
      />,
    );
    fireEvent.change(screen.getByLabelText("Search via"), {
      target: { value: "zag" },
    });
    fireEvent.click(await screen.findByText("Zagreb"));
    expect(screen.getByLabelText("Search via")).toHaveValue("");
  });

  it("does not search short queries", async () => {
    render(
      <GeocodeSearchField
        placeholder="Search"
        ariaLabel="Search start"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search start"), {
      target: { value: "p" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(geocodeMock).not.toHaveBeenCalled();
  });
});
