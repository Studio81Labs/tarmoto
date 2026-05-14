import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { NotificationBell } from "./NotificationBell";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  toggle: vi.fn(),
  ref: { current: null as HTMLDivElement | null },
  open: true,
}));

vi.mock("@/hooks", () => ({
  useDropdown: () => ({
    open: mocks.open,
    close: mocks.close,
    toggle: mocks.toggle,
    ref: mocks.ref,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api", () => ({
  accountApi: {
    getNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

describe("NotificationBell", () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    mocks.close.mockReset();
    mocks.toggle.mockReset();
    vi.mocked(accountApi.getNotifications).mockReset();
    vi.mocked(accountApi.markNotificationRead).mockReset();
    vi.mocked(accountApi.markAllNotificationsRead).mockReset();
  });

  afterEach(() => {
    useAuthStore.getState().clearSession();
  });

  it("shows fetched unread notifications and marks one read when opened", async () => {
    useAuthStore.getState().setSession(
      {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      "token-1",
    );
    vi.mocked(accountApi.getNotifications).mockResolvedValue({
      data: {
        unread_count: 1,
        items: [
          {
            id: "note-1",
            category: "trip_collaboration",
            title: "New trip suggestion",
            body: "Ada added a road to Alpine Loop",
            data: { type: "trip_collaboration", trip_id: "trip-1" },
            read_at: null,
            created_at: "2026-05-14T08:00:00.000Z",
          },
        ],
      },
    });
    vi.mocked(accountApi.markNotificationRead).mockResolvedValue({
      data: {
        id: "note-1",
        category: "trip_collaboration",
        title: "New trip suggestion",
        body: "Ada added a road to Alpine Loop",
        data: { type: "trip_collaboration", trip_id: "trip-1" },
        read_at: "2026-05-14T08:01:00.000Z",
        created_at: "2026-05-14T08:00:00.000Z",
      },
    });

    render(<NotificationBell />);

    expect(await screen.findByText("New trip suggestion")).toBeInTheDocument();
    expect(screen.getByTestId("notification-unread-indicator")).toBeVisible();

    fireEvent.click(screen.getByRole("link", { name: /new trip suggestion/i }));

    await waitFor(() => {
      expect(accountApi.markNotificationRead).toHaveBeenCalledWith("note-1");
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("can mark all notifications read", async () => {
    useAuthStore.getState().setSession(
      {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      "token-1",
    );
    vi.mocked(accountApi.getNotifications).mockResolvedValue({
      data: {
        unread_count: 1,
        items: [
          {
            id: "note-1",
            category: "new_follower",
            title: "New follower",
            body: "Ada started following you",
            data: { type: "new_follower", follower_id: "user-2" },
            read_at: null,
            created_at: "2026-05-14T08:00:00.000Z",
          },
        ],
      },
    });
    vi.mocked(accountApi.markAllNotificationsRead).mockResolvedValue({
      data: {
        unread_count: 0,
        items: [
          {
            id: "note-1",
            category: "new_follower",
            title: "New follower",
            body: "Ada started following you",
            data: { type: "new_follower", follower_id: "user-2" },
            read_at: "2026-05-14T08:02:00.000Z",
            created_at: "2026-05-14T08:00:00.000Z",
          },
        ],
      },
    });

    render(<NotificationBell />);

    fireEvent.click(
      await screen.findByRole("button", { name: /mark all read/i }),
    );

    await waitFor(() => {
      expect(accountApi.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("notification-unread-indicator")).toBeNull();
  });

  it("restores unread state when marking all notifications read fails", async () => {
    useAuthStore.getState().setSession(
      {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      "token-1",
    );
    const unreadFeed = {
      data: {
        unread_count: 1,
        items: [
          {
            id: "note-1",
            category: "new_follower" as const,
            title: "New follower",
            body: "Ada started following you",
            data: { type: "new_follower", follower_id: "user-2" },
            read_at: null,
            created_at: "2026-05-14T08:00:00.000Z",
          },
        ],
      },
    };
    vi.mocked(accountApi.getNotifications)
      .mockResolvedValueOnce(unreadFeed)
      .mockResolvedValueOnce(unreadFeed);
    vi.mocked(accountApi.markAllNotificationsRead).mockRejectedValue(
      new Error("offline"),
    );

    render(<NotificationBell />);

    fireEvent.click(
      await screen.findByRole("button", { name: /mark all read/i }),
    );

    await waitFor(() => {
      expect(accountApi.markAllNotificationsRead).toHaveBeenCalledTimes(1);
      expect(accountApi.getNotifications).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId("notification-unread-indicator")).toBeVisible();
  });

  it("waits for the auth token before fetching notifications", async () => {
    vi.mocked(accountApi.getNotifications).mockResolvedValue({
      data: {
        unread_count: 0,
        items: [],
      },
    });

    render(<NotificationBell />);

    expect(accountApi.getNotifications).not.toHaveBeenCalled();

    useAuthStore.getState().setSession(
      {
        id: "user-1",
        email: "rider@example.com",
        displayName: "Rider",
      },
      "token-1",
    );

    await waitFor(() => {
      expect(accountApi.getNotifications).toHaveBeenCalledTimes(1);
    });
  });
});
