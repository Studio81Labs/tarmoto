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

  it("forwards the callbackUrl from /login to /register so an invitee doesn't lose their invite when they sign up", async () => {
    // Regression for the Codex P2 finding on PR #489: an unauthenticated
    // /trips/join/... visitor lands on /login?callbackUrl=/trips/join/...
    // and the "Create one" link must carry the same callbackUrl so the
    // post-signup redirect lands on the invite acceptance page rather
    // than the home page.
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/join/abc-123/XYZTOKEN",
    });

    render(<LoginPage />);

    const createLink = await screen.findByRole("link", {
      name: "Create one",
    });
    expect(createLink).toHaveAttribute(
      "href",
      "/register?callbackUrl=%2Ftrips%2Fjoin%2Fabc-123%2FXYZTOKEN",
    );
  });

  it("falls back to a plain /register link when there's no callbackUrl on /login", async () => {
    searchParamValues = new URLSearchParams();

    render(<LoginPage />);

    const createLink = await screen.findByRole("link", {
      name: "Create one",
    });
    expect(createLink).toHaveAttribute("href", "/register");
  });

  it("forwards the callbackUrl from /register back to /login so the rider's invite survives the round trip", async () => {
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/join/abc-123/XYZTOKEN",
    });

    render(<RegisterPage />);

    const signInLink = await screen.findByRole("link", { name: "Sign in" });
    expect(signInLink).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Ftrips%2Fjoin%2Fabc-123%2FXYZTOKEN",
    );
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
