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
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
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
    await waitFor(() =>
      expect(geocodeMock).toHaveBeenCalledWith("pra", {
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("shows a Searching… state while the request is in flight", async () => {
    let resolveGeocode!: (
      results: { name: string; lat: number; lng: number }[],
    ) => void;
    geocodeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveGeocode = resolve;
      }),
    );
    render(
      <GeocodeSearchField
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
        placeholder="Search"
        ariaLabel="Search start"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search start"), {
      target: { value: "pra" },
    });
    // The dropdown opens with the loader as soon as the debounced fetch fires.
    expect(await screen.findByText(/Searching/)).toBeInTheDocument();
    // Resolving replaces the loader with the matches.
    resolveGeocode([{ name: "Praha", lat: 50.0755, lng: 14.4378 }]);
    expect(await screen.findByText("Praha")).toBeInTheDocument();
    expect(screen.queryByText(/Searching/)).not.toBeInTheDocument();
  });

  it("fires onSelect with the picked result and closes the dropdown", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Split", lat: 43.5081, lng: 16.4402 },
    ]);
    const onSelect = vi.fn();
    render(
      <GeocodeSearchField
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
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

  it("does not re-open/search after picking in relocate mode", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Brno, Czechia", lat: 49.1951, lng: 16.6068 },
    ]);
    render(
      <GeocodeSearchField
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
        placeholder="Search"
        ariaLabel="Search start"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search start"), {
      target: { value: "brn" },
    });
    fireEvent.click(await screen.findByText("Brno, Czechia"));
    // The picked name is written back to the input…
    expect(screen.getByLabelText("Search start")).toHaveValue("Brno, Czechia");
    geocodeMock.mockClear();
    // …but that must not re-arm the debounced search or re-open the dropdown.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(geocodeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("clears after a pick in add-via mode", async () => {
    geocodeMock.mockResolvedValue([
      { name: "Zagreb", lat: 45.815, lng: 15.9819 },
    ]);
    render(
      <GeocodeSearchField
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
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
        /* eslint-disable-next-line no-restricted-syntax -- bare fixture
           placeholder standing in for whatever caller-supplied copy the
           field renders; production callers always pass placeholder={t(...)}. */
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
