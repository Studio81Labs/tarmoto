import { render, screen } from "@testing-library/react";
import { OAuthButtons } from "./OAuthButtons";

describe("OAuthButtons", () => {
  it("does not render the divider when only unsupported providers are present", () => {
    render(<OAuthButtons providers={["github"]} />);

    expect(screen.queryByText("or continue with")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue with Apple" }),
    ).not.toBeInTheDocument();
  });
});
