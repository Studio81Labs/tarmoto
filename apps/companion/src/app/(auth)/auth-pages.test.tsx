import { render, screen, waitFor } from "@testing-library/react";
import LoginPage from "./login/page";
import RegisterPage from "./register/page";

const signInMock = vi.fn();
const registerUserMock = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "callbackUrl" ? "/trips/planner" : null),
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    registerUser: (...args: unknown[]) => registerUserMock(...args),
  };
});

describe("auth pages social sign-in", () => {
  beforeEach(() => {
    signInMock.mockReset();
    registerUserMock.mockReset();
  });

  it("keeps the login page on the credentials flow only", async () => {
    render(<LoginPage />);

    await screen.findByRole("button", { name: "Sign in" });
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue with Apple" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the registration page on the credentials flow only", async () => {
    render(<RegisterPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create account" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue with Apple" }),
    ).not.toBeInTheDocument();
  });
});
