import { render, screen } from "@testing-library/react";
import { MapLegend } from "./MapLegend";

describe("MapLegend", () => {
  it("renders nothing when no section is active", () => {
    const { container } = render(<MapLegend />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the quality scale it is given (each map passes its own)", () => {
    render(
      <MapLegend
        quality={[
          { label: "Good+", color: "#5FB97E" },
          { label: "Rough", color: "#E05A3C" },
        ]}
      />,
    );
    expect(screen.getByText("Good+")).toBeInTheDocument();
    expect(screen.getByText("Rough")).toBeInTheDocument();
  });

  it("renders a separate card per active overlay (split layout)", () => {
    const { container } = render(<MapLegend surface conditions hazards />);
    // One card each for surface, conditions, hazards.
    expect(container.querySelector("div")?.children).toHaveLength(3);
    // Surface (shared SURFACE_COLORS, capitalized keys)
    expect(screen.getByText("asphalt")).toBeInTheDocument();
    // Conditions (labels unique to this card)
    expect(screen.getByText("Full closure")).toBeInTheDocument();
    expect(screen.getByText("Seasonal pass")).toBeInTheDocument();
    // Hazards
    expect(screen.getByText("Pothole")).toBeInTheDocument();
  });
});
