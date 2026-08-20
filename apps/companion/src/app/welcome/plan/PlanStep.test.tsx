import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { INTRO_TRIAL_DAYS } from "@tarmoto/shared";
import WelcomePlanPage from "./page";
import { ApiError, accountApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

// `sys_billing_checkout`. Defaults to ENABLED — the production steady state
// AND the fail-safe direction the real hook reports while the flag map is
// unresolved, so a slow `/config/flags` never blanks the step.
const checkoutSwitch = vi.hoisted(() => ({ enabled: true, isResolved: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useSystemSwitch: () => ({
    enabled: checkoutSwitch.enabled,
    isResolved: checkoutSwitch.isResolved,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    accountApi: {
      getSubscription: vi.fn(),
      createCheckoutSession: vi.fn(),
    },
  };
});

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = vi.hoisted(() => ({ value: new URLSearchParams() }));
// ONE router object, like Next's own `useRouter`: the checkout-forward effect
// lists the router in its deps, so a fresh identity per render would re-run it
// on every render.
const routerMock = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("next/navigation", () => ({
  useRouter: () => {
    routerMock.push = mockPush;
    routerMock.replace = mockReplace;
    return routerMock;
  },
  useSearchParams: () => mockSearchParams.value,
}));

type Snapshot = Awaited<ReturnType<typeof accountApi.getSubscription>>["data"];

function snapshot(overrides: Partial<Snapshot> = {}): { data: Snapshot } {
  return {
    data: {
      current_plan: {
        tier: "free",
        // A rider with no subscription at all: the stored default, which is
        // also the shape a launch-GIFT rider carries at a paid tier.
        status: "canceled",
        renews_at: null,
        cancel_at_period_end: false,
      },
      plans: [{ tier: "free" }, { tier: "pro" }, { tier: "premium" }],
      payment_method: null,
      billing_history: [],
      portal_available: false,
      trial_eligible: false,
      provider: null,
      managed_by: null,
      ...overrides,
    } as Snapshot,
  };
}

/** What a launch-mode registration leaves behind: a paid tier with no live
 *  subscription to elect, so the status falls back to the stored `canceled`. */
const giftedSnapshot = snapshot({
  current_plan: {
    tier: "pro",
    status: "canceled",
    renews_at: null,
    cancel_at_period_end: false,
  },
});

describe("PlanStep (/welcome/plan)", () => {
  const getSubscriptionMock = vi.mocked(accountApi.getSubscription);
  const createCheckoutSessionMock = vi.mocked(accountApi.createCheckoutSession);
  const assignMock = vi.fn();

  beforeEach(() => {
    getSubscriptionMock.mockReset();
    createCheckoutSessionMock.mockReset();
    assignMock.mockReset();
    mockPush.mockReset();
    mockReplace.mockReset();
    checkoutSwitch.enabled = true;
    checkoutSwitch.isResolved = true;
    mockSearchParams.value = new URLSearchParams();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock },
    });
    // The step gates its fetch on a token to avoid the AuthSync race a
    // just-registered rider hits hardest.
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

  // ── The launch gift (#1104): acknowledge, never sell ──

  it("acknowledges the launch gift instead of selling while it is active", async () => {
    getSubscriptionMock.mockResolvedValue(giftedSnapshot);

    render(<WelcomePlanPage />);

    expect(await screen.findByText("Pro is on us")).toBeInTheDocument();
    expect(screen.getByText("Early rider gift")).toBeInTheDocument();
    // The whole point: no Checkout, no trial, no plan grid. A rider who was
    // handed Pro seconds ago must not be sold Pro.
    expect(screen.queryByRole("button", { name: "Choose Pro" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start free trial" }),
    ).toBeNull();
    expect(screen.queryByText("Choose how you ride")).toBeNull();
    // …and the gift is still skippable: one button to the dashboard.
    fireEvent.click(screen.getByRole("button", { name: "Start riding" }));
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("says the gift is permanent rather than a trial", async () => {
    getSubscriptionMock.mockResolvedValue(giftedSnapshot);

    render(<WelcomePlanPage />);

    // The grant is written once at registration and nothing else writes it, so
    // turning the gift off later cannot take it back. The copy has to promise
    // exactly that and nothing weaker.
    expect(
      await screen.findByText(/founding-rider gift, not a trial/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/stays yours/i)).toBeInTheDocument();
  });

  it("sells the full step once the operator turns the gift off", async () => {
    // Gift off → a new registration lands on `free`, and the SAME snapshot read
    // that acknowledged the gift now routes to the selling step. No second
    // switch, no client-side flag.
    getSubscriptionMock.mockResolvedValue(snapshot());

    render(<WelcomePlanPage />);

    expect(await screen.findByText("Choose how you ride")).toBeInTheDocument();
    expect(screen.queryByText("Early rider gift")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose Pro" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose Premium" }),
    ).toBeInTheDocument();
  });

  // ── Skip path ──

  it("skips to the dashboard without touching billing", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot());

    render(<WelcomePlanPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );

    expect(mockPush).toHaveBeenCalledWith("/");
    // Skipping leaves the rider on the tier registration already gave them —
    // there is nothing to persist, so nothing is called.
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("treats the Free card as the same skip", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot());

    render(<WelcomePlanPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue on Free" }),
    );

    expect(mockPush).toHaveBeenCalledWith("/");
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  // ── Trial ──

  it("offers the trial with its length from the shared constant when eligible", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot({ trial_eligible: true }));

    render(<WelcomePlanPage />);

    const proCard = (await screen.findByText("Pro")).closest("article");
    expect(
      within(proCard!).getByText(`${INTRO_TRIAL_DAYS} days free`),
    ).toBeInTheDocument();
    expect(
      within(proCard!).getByRole("button", { name: "Start free trial" }),
    ).toBeInTheDocument();
    // The Free card starts no trial, so it must not advertise one.
    const freeCard = (await screen.findByText("Free")).closest("article");
    expect(within(freeCard!).queryByText(/days free/)).toBeNull();
  });

  it("names the plan instead of a trial when the rider is not eligible", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot({ trial_eligible: false }));

    render(<WelcomePlanPage />);

    expect(
      await screen.findByRole("button", { name: "Choose Pro" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/days free/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start free trial" }),
    ).toBeNull();
  });

  it("does not advertise a trial the click cannot start", async () => {
    // `trial_eligible` stays true for a rider whose upgrade does NOT route
    // through Checkout — here a store-managed plan. The badge reads the same
    // routing the button uses (#1198), so neither appears.
    getSubscriptionMock.mockResolvedValue(
      snapshot({
        trial_eligible: true,
        provider: "apple",
        managed_by: "app_store",
      }),
    );

    render(<WelcomePlanPage />);

    expect(
      await screen.findByText("Your plan is already set up."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/days free/)).toBeNull();
  });

  // ── Checkout ──

  it("hands the rider to Stripe Checkout for a paid plan", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot());
    createCheckoutSessionMock.mockResolvedValue({
      data: { url: "https://checkout.stripe.test/session" },
    });

    render(<WelcomePlanPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose Pro" }));

    await waitFor(() =>
      expect(createCheckoutSessionMock).toHaveBeenCalledWith({ tier: "pro" }),
    );
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "https://checkout.stripe.test/session",
      ),
    );
  });

  it("surfaces a Checkout failure without stranding the rider", async () => {
    getSubscriptionMock.mockResolvedValue(snapshot());
    createCheckoutSessionMock.mockRejectedValue(
      new ApiError("Stripe is unavailable", 500, null),
    );

    render(<WelcomePlanPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose Pro" }));

    // A raw transport error carries no rider-safe message, so the translated
    // fallback is what shows — never the backend's own wording.
    expect(
      await screen.findByText("Could not start Stripe Checkout."),
    ).toBeInTheDocument();
    // The skip is still there — a billing outage must not block onboarding.
    expect(
      screen.getByRole("button", { name: "Skip for now" }),
    ).toBeInTheDocument();
  });

  // ── `sys_billing_checkout` kill switch ──

  it("disables every checkout CTA when the operator kills new subscriptions", async () => {
    checkoutSwitch.enabled = false;
    getSubscriptionMock.mockResolvedValue(snapshot({ trial_eligible: true }));

    render(<WelcomePlanPage />);

    expect(
      await screen.findByText(
        "New subscriptions are temporarily unavailable. Please try again later.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Start free trial" }),
    ).toHaveLength(2);
    for (const button of screen.getAllByRole("button", {
      name: "Start free trial",
    })) {
      expect(button).toBeDisabled();
    }
    // The switch kills CHECKOUT, not the step. Continuing on Free is a
    // navigation, so it stays live.
    const freeButton = screen.getByRole("button", { name: "Continue on Free" });
    expect(freeButton).toBeEnabled();
    fireEvent.click(freeButton);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  // ── Returning from Stripe before the webhook lands ──

  it("forwards a Checkout return to the page that verifies it", async () => {
    mockSearchParams.value = new URLSearchParams(
      "checkout=success&session_id=cs_test_123",
    );

    render(<WelcomePlanPage />);

    // The backend owns `success_url` and points it at /settings/subscription,
    // which verifies the session id and polls until the webhook-written tier
    // settles. A rider who navigates BACK into the step must land there too,
    // session id intact — never on a grid that would re-sell the plan they may
    // have just bought off a snapshot the webhook has not reached.
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        "/settings/subscription?checkout=success&session_id=cs_test_123",
      ),
    );
    expect(
      screen.getByText("Taking you to your subscription…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Choose how you ride")).toBeNull();
    // Nothing is fetched or re-sold on the way out.
    expect(getSubscriptionMock).not.toHaveBeenCalled();
  });

  it("forwards a canceled Checkout return without inventing a session id", async () => {
    mockSearchParams.value = new URLSearchParams("checkout=canceled");

    render(<WelcomePlanPage />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        "/settings/subscription?checkout=canceled",
      ),
    );
    expect(getSubscriptionMock).not.toHaveBeenCalled();
  });

  // ── Degradation ──

  it("walks the rider on when the billing backend is unreachable", async () => {
    getSubscriptionMock.mockRejectedValue(new ApiError("Not found", 404, null));

    render(<WelcomePlanPage />);

    expect(
      await screen.findByText("Your account is ready"),
    ).toBeInTheDocument();
    // No synthesized plan grid: a preview card's Checkout button cannot
    // deliver, and a plan step must never trap a brand-new account.
    expect(screen.queryByRole("button", { name: "Choose Pro" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start riding" }));
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("waits for the auth token before fetching", async () => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
    getSubscriptionMock.mockResolvedValue(snapshot());

    render(<WelcomePlanPage />);

    await waitFor(() => expect(getSubscriptionMock).not.toHaveBeenCalled());
  });
});
