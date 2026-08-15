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

  it("points back at the nearest surface that still works, and SAYS so", () => {
    // The label travels with the destination by type: a custom `backHref` with
    // the default "Back to home" copy is an accessible name that lies about
    // where the link goes, which is what shipped for the trip routes before
    // review caught it.
    render(
      <FeatureUnavailablePage backHref="/trips" backLabel="Back to trips" />,
    );

    const link = screen.getByRole("link", { name: "Back to trips" });
    expect(link).toHaveAttribute("href", "/trips");
    expect(
      screen.queryByRole("link", { name: /back to home/i }),
    ).not.toBeInTheDocument();
  });
});
