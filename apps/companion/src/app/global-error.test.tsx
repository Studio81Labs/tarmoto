import { fireEvent, render, screen } from "@testing-library/react";

// The root fallback must remain importable even when i18n bootstrap is the
// cause of the root-layout crash. This factory throws if global-error ever
// regains a dependency on the translator module.
vi.mock("@/i18n", () => {
  throw new Error("i18n bootstrap failed");
});

import GlobalError from "./global-error";

describe("global error boundary", () => {
  it("renders its static recovery UI without importing i18n", () => {
    const reset = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<GlobalError error={new Error("boom")} reset={reset} />);

    expect(screen.getByText("500")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Something skidded out" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/",
    );

    consoleSpy.mockRestore();
  });
});
