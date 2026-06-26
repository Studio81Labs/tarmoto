import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginScreen } from "./LoginScreen.js";

describe("LoginScreen", () => {
  it("renders the GitHub SSO button and triggers it", async () => {
    const onGithubSso = vi.fn();
    render(
      <LoginScreen
        onPasswordLogin={vi.fn()}
        onGithubSso={onGithubSso}
        error={null}
        passwordLoginEnabled={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /github/i }));
    expect(onGithubSso).toHaveBeenCalledTimes(1);
  });

  it("submits the password form when enabled", async () => {
    const onPasswordLogin = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginScreen
        onPasswordLogin={onPasswordLogin}
        onGithubSso={vi.fn()}
        error={null}
        passwordLoginEnabled
      />,
    );
    await userEvent.type(screen.getByLabelText(/email/i), "ops@tarmoto.app");
    await userEvent.type(screen.getByLabelText(/password/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(onPasswordLogin).toHaveBeenCalledWith("ops@tarmoto.app", "pw");
  });

  it("shows an error message", () => {
    render(
      <LoginScreen
        onPasswordLogin={vi.fn()}
        onGithubSso={vi.fn()}
        error="Invalid credentials"
        passwordLoginEnabled
      />,
    );
    expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
  });
});
