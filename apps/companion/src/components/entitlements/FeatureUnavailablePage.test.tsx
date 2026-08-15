import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { FeatureUnavailablePage } from "./FeatureUnavailablePage";

describe("FeatureUnavailablePage", () => {
  it("reads as a deliberate pause, not an error the rider caused", () => {
    render(<FeatureUnavailablePage />);

    expect(screen.getByText("OFF")).toBeInTheDocument();
    expect(screen.getByText("This feature is paused")).toBeInTheDocument();
    // The reassurance matters more than the status code here: an operator kill
    // is temporary and destroys nothing, and a rider cannot know that.
    expect(
      screen.getByText(/Nothing of yours has been deleted/i),
    ).toBeInTheDocument();
  });

  it("offers a way out, defaulting home", () => {
    render(<FeatureUnavailablePage />);
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("points back at the nearest surface that still works", () => {
    render(<FeatureUnavailablePage backHref="/trips" />);
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute(
      "href",
      "/trips",
    );
  });
});
