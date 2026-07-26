import { render, screen } from "@testing-library/react";
import { TripMetadataCount } from "./page";

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
