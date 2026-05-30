import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ProfilePage from "./page";
import { usersApi } from "@/lib/api";
import { buildLinkAccountDeepLink } from "@/lib/account-link";

const { qrToDataURLMock } = vi.hoisted(() => ({
  qrToDataURLMock: vi.fn().mockResolvedValue("data:image/png;base64,qr"),
}));

vi.mock("qrcode", () => ({
  default: {
    toDataURL: qrToDataURLMock,
  },
}));

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
      uploadAvatar: vi.fn(),
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

describe("ProfilePage", () => {
  const getMeMock = vi.mocked(usersApi.getMe);
  const uploadAvatarMock = vi.mocked(usersApi.uploadAvatar);
  const updateMeMock = vi.mocked(usersApi.updateMe);
  const clipboardWriteText = vi.fn();

  beforeEach(() => {
    vi.useRealTimers();
    getMeMock.mockReset();
    uploadAvatarMock.mockReset();
    updateMeMock.mockReset();
    qrToDataURLMock.mockClear();
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

  it("keeps the save button disabled while a second save is in flight after a prior success", async () => {
    let resolveSecondSave:
      | ((value: Awaited<ReturnType<typeof usersApi.updateMe>>) => void)
      | undefined;
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
        avatar_url: null,
        bio: "Likes mountain passes",
        home_region: "Beskydy",
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });
    updateMeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecondSave = resolve;
        }),
    );

    render(<ProfilePage />);

    expect(
      await screen.findByDisplayValue("Likes mountain passes"),
    ).toBeInTheDocument();

    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Rider Two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const saveButton = screen.getByRole("button", { name: "Saving…" });
    expect(saveButton).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    await act(async () => {
      resolveSecondSave?.({
        data: {
          id: "user-1",
          email: "rider@example.com",
          display_name: "Rider Two",
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
      await Promise.resolve();
    });

    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not block unrelated profile saves when the untouched avatar is legacy invalid data", async () => {
    getMeMock.mockResolvedValueOnce({
      data: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: "not-a-valid-url",
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
        display_name: "Updated Rider",
        phone: null,
        avatar_url: "not-a-valid-url",
        bio: "Likes mountain passes",
        home_region: "Beskydy",
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });

    render(<ProfilePage />);

    expect(
      await screen.findByDisplayValue("Likes mountain passes"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Updated Rider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMeMock).toHaveBeenCalledWith({
        display_name: "Updated Rider",
        bio: "Likes mountain passes",
        home_region: "Beskydy",
      }),
    );
  });

  it("copies the account email for mobile sign-in and clears the banner after a delay", async () => {
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

    render(<ProfilePage />);

    // Wait for the mobile-linking card to mount (its sign-in email row
    // renders only once the rider's account email is in scope), which
    // also signals the page has hydrated past first paint.
    expect(
      await screen.findByRole("button", { name: "Copy sign-in email" }),
    ).toBeInTheDocument();

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy sign-in email" }),
      );
      await Promise.resolve();
    });

    expect(clipboardWriteText).toHaveBeenCalledWith("rider@example.com");
    expect(
      screen.getByText("Email copied. Use it to sign in on mobile."),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(
      screen.queryByText("Email copied. Use it to sign in on mobile."),
    ).not.toBeInTheDocument();
  });

  it("renders a direct mobile linking handoff for the signed-in rider", async () => {
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

    render(<ProfilePage />);

    expect(
      await screen.findByRole("link", { name: "Open in Tarmoto mobile" }),
    ).toHaveAttribute("href", buildLinkAccountDeepLink("rider@example.com"));
    expect(qrToDataURLMock).toHaveBeenCalledWith(
      buildLinkAccountDeepLink("rider@example.com"),
      {
        margin: 1,
        width: 176,
        color: {
          // ink dots on cream — canonical design tokens.
          dark: "#0E0E10",
          light: "#F5EFE6",
        },
      },
    );
    expect(
      await screen.findByAltText("QR code to link the Tarmoto mobile app"),
    ).toHaveAttribute("src", "data:image/png;base64,qr");
    expect(
      screen.getByText(/scan the qr code or open tarmoto on this phone/i),
    ).toBeInTheDocument();
  });

  it("keeps the copy error visible when a previous success timer is still pending", async () => {
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
    clipboardWriteText.mockRejectedValueOnce(new Error("Clipboard denied"));

    render(<ProfilePage />);

    expect(
      await screen.findByRole("button", { name: "Copy sign-in email" }),
    ).toBeInTheDocument();

    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy sign-in email" }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText("Email copied. Use it to sign in on mobile."),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy sign-in email" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText("Could not copy your email. Please copy it manually."),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(
      screen.getByText("Could not copy your email. Please copy it manually."),
    ).toBeInTheDocument();
  });

  it("uploads an avatar file and swaps the profile preview", async () => {
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
    uploadAvatarMock.mockResolvedValueOnce({
      data: {
        id: "user-1",
        email: "rider@example.com",
        display_name: "Rider One",
        phone: null,
        avatar_url: "https://cdn.example.com/avatar-uploaded.png",
        bio: null,
        home_region: null,
        home_location: null,
        work_location: null,
        preferences: {},
        created_at: "2026-04-22T09:00:00.000Z",
      },
    });

    render(<ProfilePage />);

    // The file input is driven by the spec's `Change avatar` pill and
    // intentionally hidden from view (the pill is the visible CTA), so
    // target it directly by id rather than role / label.
    const fileInput = (await waitFor(() =>
      document.getElementById("settings-avatar-file"),
    )) as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const file = new File(["avatar"], "rider.png", { type: "image/png" });

    await act(async () => {
      fireEvent.change(fileInput!, {
        target: { files: [file] },
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(uploadAvatarMock).toHaveBeenCalledWith(file));
    expect(screen.getByAltText("Rider One's profile photo")).toHaveAttribute(
      "src",
      "https://cdn.example.com/avatar-uploaded.png",
    );
    expect(screen.getByText("Photo uploaded.")).toBeInTheDocument();
  });
});
