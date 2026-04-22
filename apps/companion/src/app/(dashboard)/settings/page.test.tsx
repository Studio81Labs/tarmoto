import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountPage from "./page";
import { usersApi } from "@/lib/api";

const authState = {
  user: {
    id: "user-1",
    email: "rider@example.com",
    displayName: "Rider One",
  },
  setUser: vi.fn(),
};

const preferencesState = {
  unitSystem: "metric" as const,
  setUnitSystem: vi.fn(),
  hydrate: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    usersApi: {
      getMe: vi.fn(),
      updateMe: vi.fn(),
    },
  };
});

vi.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) =>
    selector(authState),
}));

vi.mock("@/stores/preferences", () => ({
  usePreferencesStore: (
    selector: (state: typeof preferencesState) => unknown,
  ) => selector(preferencesState),
}));

describe("AccountPage", () => {
  const getMeMock = vi.mocked(usersApi.getMe);
  const updateMeMock = vi.mocked(usersApi.updateMe);
  const clipboardWriteText = vi.fn();

  beforeEach(() => {
    getMeMock.mockReset();
    updateMeMock.mockReset();
    authState.setUser.mockReset();
    preferencesState.setUnitSystem.mockReset();
    preferencesState.hydrate.mockReset();
    clipboardWriteText.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: clipboardWriteText,
      },
    });
  });

  it("saves the avatar URL with the rest of the profile payload", async () => {
    getMeMock.mockResolvedValueOnce({
      data: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: null,
        bio: "Likes mountain passes",
        home_region: "Beskydy",
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });
    updateMeMock.mockResolvedValueOnce({
      data: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: "https://cdn.example.com/avatar.png",
        bio: "Likes mountain passes",
        home_region: "Beskydy",
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });

    render(<AccountPage />);

    expect(
      await screen.findByDisplayValue("Likes mountain passes"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Avatar URL"), {
      target: { value: "https://cdn.example.com/avatar.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMeMock).toHaveBeenCalledWith({
        display_name: "Rider One",
        avatar_url: "https://cdn.example.com/avatar.png",
        bio: "Likes mountain passes",
        home_region: "Beskydy",
      }),
    );
  });

  it("copies the account email for mobile sign-in", async () => {
    getMeMock.mockResolvedValueOnce({
      data: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: null,
        bio: null,
        home_region: null,
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });
    clipboardWriteText.mockResolvedValueOnce(undefined);

    render(<AccountPage />);

    expect(
      await screen.findByDisplayValue("rider@example.com"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy sign-in email" }));

    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith("rider@example.com"),
    );
    expect(
      screen.getByText("Email copied. Use it to sign in on mobile."),
    ).toBeInTheDocument();
  });
});
