import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginPage from "./login/page";
import RegisterPage from "./register/page";

const signInMock = vi.fn();
const getProvidersMock = vi.fn();
const registerUserMock = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  getProviders: (...args: unknown[]) => getProvidersMock(...args),
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
    getProvidersMock.mockReset();
    registerUserMock.mockReset();
  });

  it("renders configured social providers on the login page and forwards the callback URL", async () => {
    getProvidersMock.mockResolvedValueOnce({
      credentials: { id: "credentials", name: "Email" },
      google: { id: "google", name: "Google" },
      apple: { id: "apple", name: "Apple" },
    });

    render(<LoginPage />);

    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Apple" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    expect(signInMock).toHaveBeenCalledWith("google", {
      callbackUrl: "/trips/planner",
    });
  });

  it("renders configured social providers on the registration page", async () => {
    getProvidersMock.mockResolvedValueOnce({
      credentials: { id: "credentials", name: "Email" },
      google: { id: "google", name: "Google" },
    });

    render(<RegisterPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue with Google" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Continue with Apple" }),
    ).not.toBeInTheDocument();
  });
});
