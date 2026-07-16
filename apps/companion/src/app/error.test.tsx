import { fireEvent, render, screen } from "@testing-library/react";
import ErrorPage from "./error";

describe("app error boundary page", () => {
  it("renders the 500 system state with retry and home recovery", () => {
    const reset = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorPage error={new Error("boom")} reset={reset} />);

    expect(screen.getByText("500")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /something skidded out/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /reload page/i }));
    expect(reset).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute(
      "href",
      "/",
    );
    // The crash is logged for the console/digest trail.
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
