/**
 * `sys_poi_ratings` on the road-review card (PR 5 of #1166 / #1170).
 *
 * While the switch is off the backend returns ONLY the viewer's own review
 * from `GET /roads/:id/reviews` — deliberately, so it stays deletable. That
 * makes this list a personal one rather than a community one, and mobile has
 * to say so instead of letting a paused road read as an unreviewed road.
 *
 * The delete path is the sharp edge here: on mobile it lives INSIDE the edit
 * modal, so hiding the edit entry would strand the rider's review exactly the
 * way a bare `[]` used to.
 */

import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";

jest.mock(
  "react-native/Libraries/Components/Touchable/TouchableOpacity",
  () => {
    const ReactLib = require("react");
    const { Pressable } = require("react-native");
    return {
      __esModule: true,
      default: function TouchableOpacityStub(
        props: Record<string, unknown> & { children?: React.ReactNode },
      ) {
        return ReactLib.createElement(Pressable, props, props.children);
      },
    };
  },
);

jest.mock("@/components/Icon", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("react-native-svg", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  const Stub = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return { __esModule: true, default: Stub, Path: Stub };
});

const mockGetReviews = jest.fn();
const mockFlushPendingReviews = jest.fn();
jest.mock("@/services/api", () => ({
  api: {
    getReviews: (...a: unknown[]) => mockGetReviews(...a),
    flushPendingReviews: (...a: unknown[]) => mockFlushPendingReviews(...a),
  },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: {} }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

// The offline drain is scoped to the signed-in rider — with no user it
// returns early, and the drain assertions would pass in both directions.
const mockUser: { id: string | undefined } = { id: "user-1" };
jest.mock("@/stores", () => ({
  ...jest.requireActual("@/stores"),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: mockUser.id } }),
}));

// KEYED, and separate from the kill-switch mock above: this screen reads the
// `community_access` kill switch (author links) AND the `sys_poi_ratings`
// system switch. They come from different registry kinds with different blast
// radii, so one boolean for both would let a gate on the wrong key pass.
const mockSystemSwitches: Record<string, boolean> = { sys_poi_ratings: true };
jest.mock("@/hooks/useSystemSwitch", () => ({
  useSystemSwitchEnabled: (key: string) => mockSystemSwitches[key] ?? true,
}));

// The modal drags in the photo pipeline; this suite is about the card's gating.
// Record the props so the read-only handoff can still be asserted.
const mockModalProps: { current: Record<string, unknown> | null } = {
  current: null,
};
jest.mock("@/components/ReviewFormModal", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      mockModalProps.current = props;
      return props.visible
        ? ReactLib.createElement(Text, null, "review-form")
        : null;
    },
  };
});

import { ReviewsCard } from "../RoadPreviewScreen";
import type { RoadReview } from "@/types";

function review(overrides: Partial<RoadReview> & { id: string }): RoadReview {
  return {
    id: overrides.id,
    user_id: overrides.user_id ?? "user-author",
    user_display_name: overrides.user_display_name ?? "John Rider",
    rating: overrides.rating ?? 4,
    comment: overrides.comment ?? "Fresh asphalt.",
    bike_model: overrides.bike_model ?? null,
    photos: overrides.photos ?? null,
    created_at: overrides.created_at ?? "2026-04-22T10:00:00.000Z",
    helpful_count: overrides.helpful_count ?? 0,
    not_helpful_count: overrides.not_helpful_count ?? 0,
    my_vote: overrides.my_vote ?? null,
    is_mine: overrides.is_mine ?? false,
  } as RoadReview;
}

async function renderCard(embedded: RoadReview[] = []) {
  // `render` is async in this version of the RN testing library — the sibling
  // suite's `await render(...)` is load-bearing, and without it `screen` is
  // never registered.
  return render(
    <ReviewsCard
      segmentId="seg-1"
      reviews={embedded}
      avgRating={4.2}
      onSegmentChanged={jest.fn()}
    />,
  );
}

describe("ReviewsCard — sys_poi_ratings", () => {
  beforeEach(() => {
    mockSystemSwitches.sys_poi_ratings = true;
    mockGetReviews.mockReset();
    mockGetReviews.mockResolvedValue([]);
    mockModalProps.current = null;
    mockUser.id = "user-1";
    mockFlushPendingReviews.mockReset();
    mockFlushPendingReviews.mockResolvedValue({ flushed: 0 });
    mockNavigate.mockReset();
  });

  it("offers the compose affordance while the switch is on", async () => {
    await renderCard();
    expect(
      await screen.findByLabelText("Write a review for this road"),
    ).toBeTruthy();
  });

  it("hides the compose affordance when off and the rider has no review", async () => {
    // Creating 503s, so offering the form only sets up a refusal.
    mockSystemSwitches.sys_poi_ratings = false;
    await renderCard();

    // Positive precondition: the paused state really did render.
    expect(
      await screen.findByText("Community reviews are temporarily unavailable."),
    ).toBeTruthy();
    // BOTH labels: the entry RENAMES itself to "Manage your review" when the
    // switch is off, so asserting only the compose label passes vacuously
    // against a gate that never fired. (Caught by mutation testing.)
    expect(screen.queryByLabelText("Write a review for this road")).toBeNull();
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
    expect(screen.queryByLabelText("Edit your review")).toBeNull();
  });

  it("KEEPS the entry when the rider HAS a review — it is the only delete path", async () => {
    // On mobile, delete lives inside the modal. Hiding this entry would strand
    // the rider's own review exactly the way returning `[]` used to.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValue([review({ id: "r-1", is_mine: true })]);

    await renderCard();

    const entry = await screen.findByLabelText("Manage your review");
    expect(entry).toBeTruthy();
    // And it must not promise an edit the server will refuse.
    expect(screen.queryByLabelText("Edit your review")).toBeNull();
  });

  it("hands the modal a read-only flag so Save is blocked but Delete is not", async () => {
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValue([review({ id: "r-1", is_mine: true })]);

    await renderCard();
    fireEvent.press(await screen.findByLabelText("Manage your review"));

    await waitFor(() => expect(screen.queryByText("review-form")).toBeTruthy());
    expect(mockModalProps.current?.ratingsEnabled).toBe(false);
  });

  it("REMOVES already-loaded community reviews on a LIVE FLIP", async () => {
    // The hole the first pass missed: the switch hook re-renders this card,
    // but rows fetched BEFORE the flip are still in state — so the screen
    // would show "temporarily unavailable" and then list the very reviews it
    // just called unavailable, with live vote controls that now 503.
    mockGetReviews.mockResolvedValue([
      review({ id: "r-1", user_display_name: "Jane Rider" }),
      review({ id: "r-2", is_mine: true }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByText("Jane Rider")).toBeTruthy();

    mockSystemSwitches.sys_poi_ratings = false;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={4.2}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Jane Rider")).toBeNull());
    expect(
      screen.getByText("Community reviews are temporarily unavailable."),
    ).toBeTruthy();
    // The own row survives — it is the delete path.
    expect(screen.getByLabelText("Manage your review")).toBeTruthy();
  });

  it("KEEPS the own review when the off-flip fetch FAILS", async () => {
    // The stranding bug on the error path: the fallback reseeds from the
    // ANONYMOUS embedded list, which is neutralised while ratings are off and
    // therefore carries no `is_mine` row — so the projection found nothing and
    // "Manage your review", mobile's only route to Delete, disappeared.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-1", is_mine: true }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByLabelText("Edit your review")).toBeTruthy();

    mockGetReviews.mockRejectedValueOnce(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = false;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={4.2}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));
    // The rider can still reach Delete.
    await waitFor(() =>
      expect(screen.getByLabelText("Manage your review")).toBeTruthy(),
    );
  });

  it("does not drain the offline queue while ratings are off, and resumes when back on", async () => {
    // A queued create is 503'd during a pause, so draining only burns the
    // attempt. The drain effect previously depended on neither the switch nor
    // anything that changes when it flips, so a queued review sat unsent until
    // the rider navigated away.
    mockSystemSwitches.sys_poi_ratings = false;
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalled());
    expect(mockFlushPendingReviews).not.toHaveBeenCalled();

    mockSystemSwitches.sys_poi_ratings = true;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={4.2}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockFlushPendingReviews).toHaveBeenCalled());
  });

  it("never shows one road's review as the rider's review of ANOTHER", async () => {
    // The retained own row is a fallback for a failed fetch; scoped wrong it
    // becomes a data-correctness bug. Navigating A -> B with B's request
    // failing would render A's review as the rider's review of B — and open a
    // management modal whose Delete targets B.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-A", is_mine: true, comment: "Review of road A" }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByLabelText("Manage your review")).toBeTruthy();

    // Navigate to a different segment; its personalised fetch fails.
    mockGetReviews.mockRejectedValueOnce(new Error("boom"));
    rerender(
      <ReviewsCard
        segmentId="seg-2"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledWith("seg-2"));
    // Road A's review must not be attributed to road B.
    await waitFor(() =>
      expect(screen.queryByText("Review of road A")).toBeNull(),
    );
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("forgets the retained review when the server says there is none", async () => {
    // A successful response is authoritative about ownership. The earlier
    // version of this test queued a rejection but never triggered a second
    // fetch, so the fallback never ran and "Mine" vanished from the empty
    // response alone — it passed against the stale-carry-over bug.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-1", is_mine: true, comment: "Mine" }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByLabelText("Manage your review")).toBeTruthy();

    // 2nd fetch: the rider no longer has a review here (deleted elsewhere).
    mockGetReviews.mockResolvedValueOnce([]);
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[review({ id: "other-1" })]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    // 3rd fetch FAILS — this is what exercises the retained-row fallback. If
    // the successful empty response above did not clear the retained row,
    // "Mine" comes back here.
    mockGetReviews.mockRejectedValueOnce(new Error("boom"));
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[review({ id: "other-2" })]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(3));

    await waitFor(() => expect(screen.queryByText("Mine")).toBeNull());
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("does not resurrect a DELETED review when the follow-up refresh fails", async () => {
    // Exercises the REAL path: `onSegmentChanged` swallows its own failures,
    // so after a successful delete the parent may never hand down a fresh
    // list. The previous version of this test forced `reviews={[]}` on the
    // rerender, which did the clearing the component was supposed to do — it
    // could not have caught a stale row surviving in local state.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-1", is_mine: true, comment: "Mine" }),
    ]);

    await renderCard([review({ id: "r-1", is_mine: true, comment: "Mine" })]);
    fireEvent.press(await screen.findByLabelText("Manage your review"));
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // Delete succeeds; the refresh it triggers fails and is swallowed, so no
    // new props arrive and nothing external clears the row.
    mockGetReviews.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await (mockModalProps.current?.onDeleted as () => Promise<void>)();
    });

    await waitFor(() => expect(screen.queryByText("Mine")).toBeNull());
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("keeps a JUST-SUBMITTED review deletable when every follow-up fetch fails", async () => {
    // The retention fallback only learned about rows returned by a GET. A
    // review the server accepted moments before the flip was invisible to it,
    // so a failing refresh plus a failing off-state fetch removed the rider's
    // only route to Delete for the rest of the pause.
    mockGetReviews.mockResolvedValueOnce([]);

    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // The submission succeeds; everything after it fails.
    mockGetReviews.mockRejectedValue(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = false;
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (r: unknown) => Promise<void>
      )({
        status: "uploaded",
        review: review({
          id: "r-new",
          is_mine: true,
          user_id: "user-1",
          comment: "Just made",
        }),
      });
    });

    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Manage your review")).toBeTruthy(),
    );
  });

  it("routes the 409 conflict reload through the guarded fetch", async () => {
    // The conflict reload used to issue its OWN `getReviews`, outside both the
    // request generation and the retention rule — so it could overwrite a
    // fresher response, and ownership it confirmed was invisible to the
    // fallback. Both are properties of `refreshReviews`, so the conflict path
    // delegates to it rather than duplicating it.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));

    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // The 409 reload discovers an own review the stale list did not have.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-existing", is_mine: true, comment: "Already mine" }),
    ]);
    let conflictResult: boolean | undefined;
    await act(async () => {
      conflictResult = await (
        mockModalProps.current?.onConflict as () => Promise<boolean>
      )();
    });
    expect(conflictResult).toBe(true);

    // Ownership learned here must survive a pause whose own-only fetch fails.
    mockGetReviews.mockRejectedValue(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = false;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Manage your review")).toBeTruthy(),
    );
  });

  it("never shows one rider's review to the NEXT account on this card", async () => {
    // An account switch with the card still mounted. The retained row keeps
    // satisfying `is_mine`, so without keying the target on the viewer the new
    // rider sees the previous one's review — their identity and their photos,
    // some of which are masked from other riders — behind a Delete pointed at
    // the new rider's endpoint.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-A", is_mine: true, comment: "Rider A's private note" }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByLabelText("Manage your review")).toBeTruthy();

    // Rider B signs in; their fetch fails, so only the reset can protect them.
    mockUser.id = "user-2";
    mockGetReviews.mockRejectedValue(new Error("boom"));
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("Rider A's private note")).toBeNull(),
    );
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("REFETCHES for the new account, so the next rider sees their own state", async () => {
    // Clearing is only half of it. `is_mine` is resolved per viewer, so the
    // new rider needs a fresh answer — otherwise the card sits on an empty
    // list until something unrelated happens to trigger a fetch, and rider B's
    // own review is invisible to them.
    //
    // `embedded` is a STABLE reference across both renders. A fresh `[]`
    // literal changes `embeddedReviews`, which the fetch effect also depends
    // on — so the refetch would happen through that instead and the test would
    // pass without the viewer ever being part of the key. (It did.)
    const embedded: RoadReview[] = [];
    const onSegmentChanged = jest.fn();
    const card = (
      <ReviewsCard
        segmentId="seg-1"
        reviews={embedded}
        avgRating={null}
        onSegmentChanged={onSegmentChanged}
      />
    );
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-A", is_mine: true, comment: "Rider A" }),
    ]);

    const { rerender } = await render(card);
    expect(await screen.findByLabelText("Edit your review")).toBeTruthy();

    mockUser.id = "user-2";
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-B", is_mine: true, comment: "Rider B" }),
    ]);
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={embedded}
        avgRating={null}
        onSegmentChanged={onSegmentChanged}
      />,
    );

    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Rider B")).toBeTruthy();
    expect(screen.queryByText("Rider A")).toBeNull();
  });

  it("discards a submission that completed AFTER an account switch", async () => {
    // Rider A submits; B signs in before the request comes back. Seeding
    // unconditionally would install A's review as B's — A's content and photos
    // behind a Delete pointed at B's endpoint — and the refresh that would
    // normally correct it swallows its own failures.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // B signs in while A's submission is still in flight.
    mockUser.id = "user-2";
    mockGetReviews.mockRejectedValue(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = false;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    // Let the viewer-change refetch settle INSIDE the test; a rejection that
    // lands afterwards is attributed to whichever test runs next.
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    // A's submission lands.
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (r: unknown) => Promise<void>
      )({
        status: "uploaded",
        review: review({
          id: "r-A",
          is_mine: true,
          user_id: "user-1",
          comment: "Rider A's private note",
        }),
      });
    });

    expect(screen.queryByText("Rider A's private note")).toBeNull();
    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("still seeds a submission made by the CURRENT rider", async () => {
    // Positive control: the identity check must not break the normal path.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    mockGetReviews.mockRejectedValue(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = false;
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (r: unknown) => Promise<void>
      )({
        status: "uploaded",
        review: review({ id: "r-mine", is_mine: true, user_id: "user-1" }),
      });
    });

    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Manage your review")).toBeTruthy(),
    );
  });

  it("CLOSES the open editor when the account changes", async () => {
    // `ReviewFormModal` stops taking `initialReview` once it has seeded, so an
    // editor left open across a sign-out shows the new rider the previous
    // one's text and photos — and Save or Delete then acts on the NEW rider's
    // review using that content.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-A", is_mine: true, user_id: "user-1" }),
    ]);
    const { rerender } = await renderCard();
    fireEvent.press(await screen.findByLabelText("Edit your review"));
    await waitFor(() => expect(screen.queryByText("review-form")).toBeTruthy());

    mockUser.id = "user-2";
    mockGetReviews.mockResolvedValueOnce([]);
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.queryByText("review-form")).toBeNull());
  });

  it("keeps the manage route when the RE-ENABLE fetch fails", async () => {
    // The other direction. The embedded list is the parent's ANONYMOUS
    // payload, so it can never carry `is_mine` — falling back to it alone
    // removed the rider's Edit/Delete route for a review the server had
    // confirmed moments earlier.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-mine", is_mine: true, user_id: "user-1" }),
    ]);

    const { rerender } = await renderCard();
    expect(await screen.findByLabelText("Manage your review")).toBeTruthy();

    // Ratings come back; that refetch fails.
    mockGetReviews.mockRejectedValueOnce(new Error("boom"));
    mockSystemSwitches.sys_poi_ratings = true;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[review({ id: "r-other" })]}
        avgRating={4.2}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    // Own controls survive, and the community rows the parent supplied are
    // still shown alongside.
    await waitFor(() =>
      expect(screen.getByLabelText("Edit your review")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Write a review for this road")).toBeNull();
  });

  it("discards a SUBMISSION that finished after the road changed", async () => {
    // Same rider, different road. The viewer check added earlier passes, so
    // only the target generation catches this: A's review would be installed
    // as the rider's review of B, and the editor opened from it points at B's
    // endpoint.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // The card moves to another road while the submission is in flight.
    mockGetReviews.mockResolvedValueOnce([]);
    rerender(
      <ReviewsCard
        segmentId="seg-2"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledWith("seg-2"));

    // Road A's submission lands.
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (r: unknown) => Promise<void>
      )({
        status: "uploaded",
        review: review({
          id: "r-A",
          is_mine: true,
          user_id: "user-1",
          comment: "Review of road A",
        }),
      });
    });

    expect(screen.queryByText("Review of road A")).toBeNull();
    expect(screen.queryByLabelText("Edit your review")).toBeNull();
  });

  it("discards a DELETE that finished after the road changed", async () => {
    // The opposite harm: clearing the NEW road's own review because a delete
    // on the previous one came back late.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-A", is_mine: true, user_id: "user-1" }),
    ]);
    const { rerender } = await renderCard();
    fireEvent.press(await screen.findByLabelText("Edit your review"));
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // Move to road B, where this rider also has a review.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-B", is_mine: true, user_id: "user-1", comment: "On B" }),
    ]);
    rerender(
      <ReviewsCard
        segmentId="seg-2"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledWith("seg-2"));
    expect(await screen.findByLabelText("Edit your review")).toBeTruthy();

    // Road A's delete completes now.
    await act(async () => {
      await (mockModalProps.current?.onDeleted as () => Promise<void>)();
    });

    // B's review is untouched.
    expect(screen.getByLabelText("Edit your review")).toBeTruthy();
    expect(screen.getByText("On B")).toBeTruthy();
  });

  it("says UNAVAILABLE rather than 'no reviews yet'", async () => {
    // The silent empty state: a road that genuinely has reviews would
    // otherwise be indistinguishable from one that has none.
    mockSystemSwitches.sys_poi_ratings = false;
    await renderCard();

    expect(
      await screen.findByText("Community reviews are temporarily unavailable."),
    ).toBeTruthy();
    expect(screen.queryByText(/No reviews yet/)).toBeNull();
  });

  it("keeps the normal empty state while the switch is on", async () => {
    await renderCard();
    expect(await screen.findByText(/No reviews yet/)).toBeTruthy();
    expect(
      screen.queryByText("Community reviews are temporarily unavailable."),
    ).toBeNull();
  });
});
