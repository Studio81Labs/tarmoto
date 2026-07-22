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

  it("renders a caller-translated label", () => {
    render(
      <RouteCollectionVisibilityPill visibility="unlisted" label="Unlisted" />,
    );

    expect(screen.getByText("Unlisted")).toBeInTheDocument();
  });
});
