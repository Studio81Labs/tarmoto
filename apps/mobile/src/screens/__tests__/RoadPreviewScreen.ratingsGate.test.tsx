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
const mockVoteOnReview = jest.fn();
jest.mock("@/services/api", () => ({
  api: {
    getReviews: (...a: unknown[]) => mockGetReviews(...a),
    voteOnReview: (...a: unknown[]) => mockVoteOnReview(...a),
    clearReviewVote: (...a: unknown[]) => mockVoteOnReview(...a),
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
    mockVoteOnReview.mockReset();
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
    await waitFor(() =>
      expect(mockGetReviews.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

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
      await (mockModalProps.current?.onDeleted as (s: number) => Promise<void>)(
        mockModalProps.current?.session as number,
      );
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
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({
            id: "r-new",
            is_mine: true,
            user_id: "user-1",
            comment: "Just made",
          }),
        },
        mockModalProps.current?.session as number,
      );
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
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({
            id: "r-A",
            is_mine: true,
            user_id: "user-1",
            comment: "Rider A's private note",
          }),
        },
        mockModalProps.current?.session as number,
      );
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
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({ id: "r-mine", is_mine: true, user_id: "user-1" }),
        },
        mockModalProps.current?.session as number,
      );
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
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({
            id: "r-A",
            is_mine: true,
            user_id: "user-1",
            comment: "Review of road A",
          }),
        },
        mockModalProps.current?.session as number,
      );
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
      await (mockModalProps.current?.onDeleted as (s: number) => Promise<void>)(
        mockModalProps.current?.session as number,
      );
    });

    // B's review is untouched.
    expect(screen.getByLabelText("Edit your review")).toBeTruthy();
    expect(screen.getByText("On B")).toBeTruthy();
  });

  it("refreshes the parent AGGREGATE when ratings resume", async () => {
    // `avgRating` is a prop from the parent's road-detail fetch, and the
    // backend neutralises that aggregate while ratings are paused. A flip only
    // re-runs the review fetch — so a screen first loaded during a pause kept
    // a null average after the operator restored ratings, until the rider
    // navigated away and back.
    //
    // This asserts the parent refresh is REQUESTED. The earlier back-on test
    // passes `avgRating` itself, so it could never have caught this.
    const onSegmentChanged = jest.fn();
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValue([]);

    const card = () => (
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={onSegmentChanged}
      />
    );
    const { rerender } = await render(card());
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    // Not on first render — the parent has just fetched.
    expect(onSegmentChanged).not.toHaveBeenCalled();

    mockSystemSwitches.sys_poi_ratings = true;
    rerender(card());

    await waitFor(() => expect(onSegmentChanged).toHaveBeenCalled());
  });

  it("discards A's completion even after the editor is REOPENED on B", async () => {
    // The single shared token was overwritten by reopening: `openForm` on B
    // stamped B's generation, so the comparison saw B on both sides and
    // accepted A's stale completion. The token now travels with the request.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());
    // A's editor session, captured as the modal would at request start.
    const sessionA = mockModalProps.current?.session as number;

    // Navigate to B and open ITS editor, which rewrites the shared token.
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
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() =>
      expect(mockModalProps.current?.session).not.toBe(sessionA),
    );

    // A's submission finally lands, carrying A's session.
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({
            id: "r-A",
            is_mine: true,
            user_id: "user-1",
            comment: "Belongs to road A",
          }),
        },
        sessionA,
      );
    });

    expect(screen.queryByText("Belongs to road A")).toBeNull();
    expect(screen.queryByLabelText("Edit your review")).toBeNull();
  });

  it("ignores a read that was already in flight when a DELETE succeeded", async () => {
    // The generation only advanced when another fetch STARTED, so a GET issued
    // before the mutation stayed authoritative and landed afterwards — putting
    // the deleted row, and its Manage/Delete controls, straight back.
    mockSystemSwitches.sys_poi_ratings = false;
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-mine", is_mine: true, user_id: "user-1" }),
    ]);

    const { rerender } = await renderCard();
    fireEvent.press(await screen.findByLabelText("Manage your review"));
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // A second read starts and stays outstanding.
    let resolveInFlight: ((v: unknown) => void) | undefined;
    mockGetReviews.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInFlight = resolve;
      }),
    );
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[review({ id: "r-other" })]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    // Delete succeeds while it is still open.
    await act(async () => {
      await (mockModalProps.current?.onDeleted as (s: number) => Promise<void>)(
        mockModalProps.current?.session as number,
      );
    });
    // Isolate: the delete itself cleared the controls.
    expect(screen.queryByLabelText("Manage your review")).toBeNull();

    // The pre-delete read now lands, still carrying the review.
    await act(async () => {
      resolveInFlight?.([
        review({ id: "r-mine", is_mine: true, user_id: "user-1" }),
      ]);
    });

    expect(screen.queryByLabelText("Manage your review")).toBeNull();
  });

  it("ignores a read that was already in flight when a SUBMISSION succeeded", async () => {
    // The inverse of the delete case: a GET issued before the create lands
    // afterwards carrying no own review, and without invalidation it erases
    // the review the server had just accepted.
    mockGetReviews.mockResolvedValueOnce([]);
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(1));
    fireEvent.press(
      await screen.findByLabelText("Write a review for this road"),
    );
    await waitFor(() => expect(mockModalProps.current).not.toBeNull());

    // A read starts and stays outstanding.
    let resolveInFlight: ((v: unknown) => void) | undefined;
    mockGetReviews.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInFlight = resolve;
      }),
    );
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[review({ id: "r-other" })]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalledTimes(2));

    // The submission succeeds while it is still open. Ratings stay ON here —
    // this is about read ordering, not the gate — so the entry is labelled
    // "Edit your review".
    await act(async () => {
      await (
        mockModalProps.current?.onSubmitted as (
          r: unknown,
          s: number,
        ) => Promise<void>
      )(
        {
          status: "uploaded",
          review: review({
            id: "r-new",
            is_mine: true,
            user_id: "user-1",
            comment: "Just submitted",
          }),
        },
        mockModalProps.current?.session as number,
      );
    });
    expect(await screen.findByLabelText("Edit your review")).toBeTruthy();

    // The pre-create read lands, reporting no own review.
    await act(async () => {
      resolveInFlight?.([]);
    });

    expect(screen.getByLabelText("Edit your review")).toBeTruthy();
  });

  it("retries once when a drain coalesced into one that spanned the pause", async () => {
    // `drainReviewQueue` returns a single shared in-flight promise, so the
    // re-enable drain can join one that started while ratings were paused and
    // took the intentional 503. That result says nothing about now, and
    // nothing else re-runs — the review would sit queued until the rider
    // navigated or the operator flipped again.
    mockSystemSwitches.sys_poi_ratings = false;
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalled());
    expect(mockFlushPendingReviews).not.toHaveBeenCalled();

    // First (coalesced) drain reports the 503 it took while paused; the retry
    // succeeds.
    mockFlushPendingReviews
      .mockResolvedValueOnce({ flushed: 0, transientServerError: true })
      .mockResolvedValueOnce({ flushed: 1, transientServerError: false });

    mockSystemSwitches.sys_poi_ratings = true;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(mockFlushPendingReviews).toHaveBeenCalledTimes(2),
    );
  });

  it("does not retry a drain that failed for a non-transient reason", async () => {
    // Bounded: only the coalesced-503 shape earns a second attempt.
    mockSystemSwitches.sys_poi_ratings = false;
    const { rerender } = await renderCard();
    await waitFor(() => expect(mockGetReviews).toHaveBeenCalled());

    mockFlushPendingReviews.mockResolvedValue({
      flushed: 0,
      transientServerError: false,
    });
    mockSystemSwitches.sys_poi_ratings = true;
    rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    await waitFor(() =>
      expect(mockFlushPendingReviews).toHaveBeenCalledTimes(1),
    );
    // Give any stray retry a chance to appear before asserting it did not.
    await act(async () => {});
    expect(mockFlushPendingReviews).toHaveBeenCalledTimes(1);
  });

  it("drops a vote that completes across a switch flip", async () => {
    // The projection unmounts the row on a flip, resetting its `pending` lock,
    // but the in-flight closure keeps running. Applying its result — or its
    // rollback — would overwrite the counts the re-enable read brought in.
    mockGetReviews.mockResolvedValueOnce([
      review({ id: "r-1", helpful_count: 3 }),
    ]);
    let resolveVote: ((v: unknown) => void) | undefined;
    mockVoteOnReview.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVote = resolve;
      }),
    );

    const { rerender } = await renderCard();
    fireEvent.press(
      await screen.findByLabelText("Mark this review as helpful"),
    );
    await waitFor(() => expect(mockVoteOnReview).toHaveBeenCalledTimes(1));

    // Off and back on; the re-enable read carries fresher counts.
    mockGetReviews.mockResolvedValue([review({ id: "r-1", helpful_count: 9 })]);
    mockSystemSwitches.sys_poi_ratings = false;
    await rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    mockSystemSwitches.sys_poi_ratings = true;
    await rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    expect(await screen.findByText("9")).toBeTruthy();
    // Let both flip-triggered reads settle INSIDE the test; one resolving
    // afterwards is attributed to whichever test runs next.
    await waitFor(() =>
      expect(mockGetReviews.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    // The pre-flip vote lands with its stale counts.
    await act(async () => {
      resolveVote?.({ helpful_count: 4, not_helpful_count: 0, my_vote: true });
    });

    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.queryByText("4")).toBeNull();

    // Both rerenders are awaited above: `render`/`rerender` are async here, and
    // firing the two flips back-to-back left reads in flight whose resolution
    // landed after this test ended — where Jest attributes it to whichever one
    // runs next. This suite lost two unrelated cases to exactly that.
  });

  it("will not accept a SECOND vote after a flip remounts the row", async () => {
    // The lock used to live inside the row, which the projection unmounts on a
    // flip — so it came back unlocked and an opposite vote could be cast while
    // the first was still running. Dropping the stale response is not enough:
    // both writes reach the backend, and out of order the server keeps a vote
    // the rider cannot see.
    mockGetReviews.mockResolvedValue([review({ id: "r-1", helpful_count: 3 })]);
    mockVoteOnReview.mockReturnValue(new Promise(() => {}));

    const { rerender } = await renderCard();
    fireEvent.press(
      await screen.findByLabelText("Mark this review as helpful"),
    );
    await waitFor(() => expect(mockVoteOnReview).toHaveBeenCalledTimes(1));

    mockSystemSwitches.sys_poi_ratings = false;
    await rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );
    mockSystemSwitches.sys_poi_ratings = true;
    await rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    // The opposite vote on the remounted row must not reach the backend.
    fireEvent.press(
      await screen.findByLabelText("Mark this review as not helpful"),
    );
    await act(async () => {});
    expect(mockVoteOnReview).toHaveBeenCalledTimes(1);
  });

  it("clears a pending vote lock when the ACCOUNT changes", async () => {
    // Target-scoped like the rest of the reset. Left standing, a vote the
    // previous rider had pending keeps the same review id disabled for the
    // next one — indefinitely if that request hangs.
    mockGetReviews.mockResolvedValue([review({ id: "r-1", helpful_count: 3 })]);
    mockVoteOnReview.mockReturnValue(new Promise(() => {}));

    const { rerender } = await renderCard();
    fireEvent.press(
      await screen.findByLabelText("Mark this review as helpful"),
    );
    await waitFor(() => expect(mockVoteOnReview).toHaveBeenCalledTimes(1));

    // A different rider signs in on the same road.
    mockUser.id = "user-2";
    await rerender(
      <ReviewsCard
        segmentId="seg-1"
        reviews={[]}
        avgRating={null}
        onSegmentChanged={jest.fn()}
      />,
    );

    // The control must be usable again for the new rider.
    const control = await screen.findByLabelText("Mark this review as helpful");
    expect(control.props.accessibilityState?.disabled).not.toBe(true);
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
