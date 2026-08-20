import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** The registration form navigates with `window.location.href`, which jsdom
 *  refuses to follow — swap in a plain object so the destination is readable. */
const locationMock = { href: "", origin: "" };

/** Fill and submit the registration form. */
async function submitRegistration() {
  fireEvent.change(await screen.findByPlaceholderText("RoadWarrior42"), {
    target: { value: "New Rider" },
  });
  fireEvent.change(screen.getByPlaceholderText("rider@example.com"), {
    target: { value: "new-rider@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText(/^Min\./), {
    target: { value: "StrongPass1!" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("auth pages social sign-in", () => {
  beforeEach(() => {
    signInMock.mockReset();
    registerUserMock.mockReset();
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/planner",
    });
    locationMock.href = "";
    // `safeCallbackUrl` resolves the raw param against this origin, so it has
    // to be the real one or every callbackUrl reads as cross-origin.
    locationMock.origin = window.location.origin;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: locationMock,
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

  it("preserves a localized public-page callback through social authentication", async () => {
    searchParamValues = new URLSearchParams({
      callbackUrl: "/explore?lang=cs",
    });

    render(<LoginPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with Google" }),
    );
    expect(signInMock).toHaveBeenCalledWith("google", {
      callbackUrl: "/explore?lang=cs",
    });
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
    // and the registration link must carry the same callbackUrl so the
    // post-signup redirect lands on the invite acceptance page rather
    // than the home page.
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/join/abc-123/XYZTOKEN",
    });

    render(<LoginPage />);

    const createLink = await screen.findByRole("link", {
      name: "Don't have an account? Create one",
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
      name: "Don't have an account? Create one",
    });
    expect(createLink).toHaveAttribute("href", "/register");
  });

  it("forwards the callbackUrl from /register back to /login so the rider's invite survives the round trip", async () => {
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/join/abc-123/XYZTOKEN",
    });

    render(<RegisterPage />);

    const signInLink = await screen.findByRole("link", {
      name: "Already have an account? Sign in",
    });
    expect(signInLink).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Ftrips%2Fjoin%2Fabc-123%2FXYZTOKEN",
    );
  });

  it("routes a brand-new rider to the plan step (#1173)", async () => {
    // No callbackUrl: the default `/` destination becomes the skippable plan
    // step. The account already exists on its tier by the time this navigates,
    // so nothing about the step is load-bearing for the registration itself.
    searchParamValues = new URLSearchParams();
    registerUserMock.mockResolvedValue(undefined);
    signInMock.mockResolvedValue({ error: null });

    render(<RegisterPage />);
    await submitRegistration();

    await waitFor(() => expect(locationMock.href).toBe("/welcome/plan"));
  });

  it("does not hijack an invite callbackUrl with the plan step", async () => {
    // A rider who arrived from a trip invite came for the invite. The plan step
    // is skippable and permanently reachable at /settings/subscription, so
    // stealing the destination to sell a plan is the worse trade.
    searchParamValues = new URLSearchParams({
      callbackUrl: "/trips/join/abc-123/XYZTOKEN",
    });
    registerUserMock.mockResolvedValue(undefined);
    signInMock.mockResolvedValue({ error: null });

    render(<RegisterPage />);
    await submitRegistration();

    await waitFor(() =>
      expect(locationMock.href).toBe("/trips/join/abc-123/XYZTOKEN"),
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
