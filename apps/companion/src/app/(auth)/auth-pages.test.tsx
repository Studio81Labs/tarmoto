import { render, screen, waitFor } from "@testing-library/react";
import LoginPage from "./login/page";
import RegisterPage from "./register/page";

const signInMock = vi.fn();
const registerUserMock = vi.fn();
let searchParamValues = new URLSearchParams();

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => searchParamValues.get(key),
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    registerUser: (...args: unknown[]) => registerUserMock(...args),
  };
});

vi.mock("@/lib/oauth-providers", () => ({
  getEnabledOAuthProviders: () => ["google", "apple"],
}));

describe("auth pages social sign-in", () => {
  beforeEach(() => {
    signInMock.mockReset();
    registerUserMock.mockReset();
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/planner",
    });
  });

  it("renders the configured social providers on the login page", async () => {
    render(<LoginPage />);

    await screen.findByRole("button", { name: "Sign in" });
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Apple" }),
    ).toBeInTheDocument();
  });

  it("renders the configured social providers on the registration page", async () => {
    render(<RegisterPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create account" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Apple" }),
    ).toBeInTheDocument();
  });

  it("shows a helpful message when a social login collides with a password account", async () => {
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/planner",
      error: "social_account_conflict",
    });

    render(<LoginPage />);

    expect(
      await screen.findByText(
        "This email already has a Tarmoto password account. Sign in with your password instead.",
      ),
    ).toBeInTheDocument();
  });

  it("clears the URL-driven login error when the error param is removed", async () => {
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/planner",
      error: "social_account_conflict",
    });

    const { rerender } = render(<LoginPage />);

    expect(
      await screen.findByText(
        "This email already has a Tarmoto password account. Sign in with your password instead.",
      ),
    ).toBeInTheDocument();

    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/planner",
    });
    rerender(<LoginPage />);

    await waitFor(() =>
      expect(
        screen.queryByText(
          "This email already has a Tarmoto password account. Sign in with your password instead.",
        ),
      ).not.toBeInTheDocument(),
    );
  });
});
