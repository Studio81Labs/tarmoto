import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DataPage from "./page";
import { accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

// The delete-account confirm dialog preflights `GET /account/subscription`
// (Codex round 11, PR #1120) so a paid rider is warned about restoration/
// cancellation consequences BEFORE the mutating `DELETE /account` call —
// warning only after the delete would already be too late.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    accountApi: {
      ...actual.accountApi,
      getSubscription: vi.fn(),
      deleteAccount: vi.fn(),
      requestDataExport: vi.fn(),
      getDataExport: vi.fn(),
    },
  };
});

const signOutMock = vi.fn();
vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

describe("DataPage delete-account subscription preflight", () => {
  const getSubscriptionMock = vi.mocked(accountApi.getSubscription);

  beforeEach(() => {
    getSubscriptionMock.mockReset();
    signOutMock.mockReset();
    useAuthStore.setState({
      user: {
        id: "test-user",
        email: "rider@example.com",
        displayName: "Rider",
      },
      isAuthenticated: true,
      accessToken: "test-access-token",
    });
  });

  afterEach(() => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
  });

  function openConfirmDialog() {
    render(<DataPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    return screen.getByRole("dialog", { name: "Delete account permanently" });
  }

  it("warns a paid Stripe subscriber that restoration after the period ends can't reinstate", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: true,
        trial_eligible: true,
        provider: "stripe",
        managed_by: "stripe_portal",
      },
    });

    const dialog = openConfirmDialog();

    expect(
      await screen.findByText(
        /Your paid Stripe subscription will stop renewing when your account is deleted/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /we can't reinstate it — you'll need to subscribe again/,
      ),
    ).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });

  it("warns an App Store subscriber that deleting the account does not cancel it", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "premium",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      },
    });

    openConfirmDialog();

    expect(
      await screen.findByText(
        /Your subscription is managed by the App Store\. Deleting your account does not cancel it/,
      ),
    ).toBeInTheDocument();
    // The Google Play / Stripe warnings must not also render.
    expect(
      screen.queryByText(/managed by Google Play/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/paid Stripe subscription will stop renewing/),
    ).not.toBeInTheDocument();
  });

  it("warns a Google Play subscriber that the backend can't reactivate a restored subscription", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "pro",
          status: "active",
          renews_at: "2026-11-15T00:00:00.000Z",
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: "google",
        managed_by: "play_store",
      },
    });

    openConfirmDialog();

    expect(
      await screen.findByText(
        /Your subscription is managed by Google Play\. Deleting your account does not cancel it/,
      ),
    ).toBeInTheDocument();
  });

  it("shows only the generic deletion copy for a free account (no subscription warning)", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "free",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });

    openConfirmDialog();

    // Let the preflight fetch resolve before asserting its absence.
    await screen.findByText(
      "This will schedule your account and all associated personal data for deletion within 30 days. We'll email you a confirmation.",
    );
    expect(
      screen.queryByText(/paid Stripe subscription will stop renewing/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/managed by the App Store/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/managed by Google Play/),
    ).not.toBeInTheDocument();
  });

  it("warns a store-owned account even while the tier is temporarily free (Google Play hold/pause, Apple billing retry)", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      data: {
        current_plan: {
          tier: "free",
          status: "past_due",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: "google",
        managed_by: "play_store",
      },
    });

    openConfirmDialog();

    // The store still owns the slot during a hold/pause even though the
    // tier reported to the companion has dropped to "free" — the rider
    // must still be told to cancel in Google Play.
    expect(
      await screen.findByText(
        /Your subscription is managed by Google Play\. Deleting your account does not cancel it/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/paid Stripe subscription will stop renewing/),
    ).not.toBeInTheDocument();
  });

  it("disables the delete confirm button while the preflight is still loading, and enables it once resolved", async () => {
    let resolveSubscription!: (
      value: Awaited<ReturnType<typeof accountApi.getSubscription>>,
    ) => void;
    getSubscriptionMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
    );

    openConfirmDialog();

    fireEvent.change(screen.getByLabelText("Your email address"), {
      target: { value: "rider@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Your password"), {
      target: { value: "correct horse battery staple" },
    });

    const deleteButton = screen.getByRole("button", { name: "Delete account" });
    // Valid email + password, but the preflight hasn't resolved yet — the
    // rider must not be able to fire the mutating delete before any
    // provider-specific warning has had a chance to paint.
    expect(deleteButton).toBeDisabled();

    resolveSubscription({
      data: {
        current_plan: {
          tier: "free",
          status: "canceled",
          renews_at: null,
          cancel_at_period_end: false,
        },
        plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
        payment_method: null,
        billing_history: [],
        portal_available: false,
        trial_eligible: true,
        provider: null,
        managed_by: null,
      },
    });

    await waitFor(() => expect(deleteButton).not.toBeDisabled());
  });

  it("falls back to the generic copy without blocking deletion when the preflight fetch fails", async () => {
    getSubscriptionMock.mockRejectedValueOnce(new Error("Failed to fetch"));

    openConfirmDialog();

    await screen.findByText(
      "This will schedule your account and all associated personal data for deletion within 30 days. We'll email you a confirmation.",
    );
    expect(
      screen.queryByText(/paid Stripe subscription will stop renewing/),
    ).not.toBeInTheDocument();
    // The confirm button stays available — a failed preflight never blocks
    // the deletion flow.
    expect(
      screen.getByRole("button", { name: "Delete account" }),
    ).toBeInTheDocument();
  });
});
