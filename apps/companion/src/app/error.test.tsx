import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mocked so the test asserts the capture call without initializing the SDK.
const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => (s: string) => s,
}));

import ErrorBoundaryPage from "./error";

describe("route error boundary", () => {
  it("reports the caught error to Sentry — boundary-caught errors are invisible to the SDK's global handlers", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("map exploded"), {
      digest: "digest-1",
    });

    render(<ErrorBoundaryPage error={error} reset={vi.fn()} />);

    // The #1255 map-page crash landed in this boundary and never reached
    // Sentry; regressing this capture makes whole-page crashes silent again.
    expect(captureException).toHaveBeenCalledWith(error);
    expect(consoleSpy).toHaveBeenCalledWith(error);
    expect(screen.getByText("500")).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});
