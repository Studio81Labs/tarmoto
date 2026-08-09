import { render, screen } from "@testing-library/react";
import { TripDraftCard, TripMetadataCount, TripsEmptyCard } from "./page";

describe("TripMetadataCount", () => {
  it.each([
    { count: 3, kind: "days" as const, label: "3 DAYS" },
    { count: 4, kind: "passes" as const, label: "4 PASSES" },
  ])("emphasizes the formatted count in $label", ({ count, kind, label }) => {
    const { container } = render(
      <TripMetadataCount count={count} kind={kind} />,
    );

    expect(container).toHaveTextContent(label);
    expect(screen.getByText(String(count))).toHaveClass(
      "font-bold",
      "text-ink",
    );
  });
});

describe("TripsEmptyCard", () => {
  it("offers the planner CTA normally", () => {
    render(<TripsEmptyCard planningEnabled />);
    expect(screen.getByRole("link", { name: /plan a trip/i })).toHaveAttribute(
      "href",
      "/trips/planner",
    );
  });

  it("drops the CTA when trip planning is killed, keeping the card", () => {
    // The first-time empty state is the one path a brand-new rider is
    // guaranteed to see, so a link to a killed destination here is the most
    // likely dead end on the whole dashboard — and it was the one the earlier
    // entry-link pass missed, because it gated the quick action and the
    // populated-layout CTAs and not this branch.
    render(<TripsEmptyCard planningEnabled={false} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // The card still explains the empty state; only the dead action goes.
    expect(screen.getByText(/no trips planned yet/i)).toBeInTheDocument();
  });
});
describe("TripDraftCard", () => {
  const draft = {
    id: "t1",
    name: "Alpine loop",
    status: "draft",
    num_days: 2,
    distance_km: 320,
    quality_avg: 4.4,
  };

  it("shows the quality glyph normally", () => {
    render(<TripDraftCard trip={draft} seed={1} qualityEnabled />);
    expect(screen.getByTestId("trip-draft-quality")).toBeInTheDocument();
  });

  it("drops the glyph when the overlay is killed, keeping the card", () => {
    // Same treatment as the /trips catalog card: the sketch collapses to the
    // neutral mid-tier so the card keeps its look, and the glyph goes.
    render(<TripDraftCard trip={draft} seed={1} qualityEnabled={false} />);
    expect(screen.queryByTestId("trip-draft-quality")).toBeNull();
    expect(screen.getByText("Alpine loop")).toBeInTheDocument();
  });
});
