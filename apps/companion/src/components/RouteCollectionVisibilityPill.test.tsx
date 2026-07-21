import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RouteCollectionVisibilityPill } from "./RouteCollectionVisibilityPill";

describe("RouteCollectionVisibilityPill", () => {
  it("uses an explicit request-scoped label when provided", () => {
    render(
      <RouteCollectionVisibilityPill visibility="public" label="Veřejné" />,
    );

    expect(screen.getByText("Veřejné")).toBeInTheDocument();
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
  });

  it("uses the client translator when no label override is provided", () => {
    render(<RouteCollectionVisibilityPill visibility="unlisted" />);

    expect(screen.getByText("Unlisted")).toBeInTheDocument();
  });
});
