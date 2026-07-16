import { render, screen } from "@testing-library/react";
import NotFound from "./not-found";

describe("app not-found page", () => {
  it("renders the 404 system state with recovery navigation", () => {
    render(<NotFound />);

    expect(screen.getByText("404")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /this road isn’t on the map/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("link", { name: /open road explorer/i }),
    ).toHaveAttribute("href", "/explore");
  });
});
