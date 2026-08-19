import { fireEvent, render, screen } from "@testing-library/react";

// The root fallback must remain importable even when i18n bootstrap is the
// cause of the root-layout crash. This factory throws if global-error ever
// regains a dependency on the translator module.
vi.mock("@/i18n", () => {
  throw new Error("i18n bootstrap failed");
});

// Mocked so the test asserts the capture call without initializing the SDK.
const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import GlobalError from "./global-error";

describe("global error boundary", () => {
  it("renders its static recovery UI without importing i18n", () => {
    const reset = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");

    render(<GlobalError error={error} reset={reset} />);

    // The root boundary is the last place a root-layout crash can still
    // reach Sentry — regressing this loses exactly the worst errors.
    expect(captureException).toHaveBeenCalledWith(error);

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
