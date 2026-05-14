import { render, screen } from "@testing-library/react";
import NotFound from "./not-found";

describe("app not-found page", () => {
  it("renders branded recovery navigation", () => {
    render(<NotFound />);

    expect(
      screen.getByRole("heading", { name: /road not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go home/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("link", { name: /open explorer/i }),
    ).toHaveAttribute("href", "/explore");
  });
});
