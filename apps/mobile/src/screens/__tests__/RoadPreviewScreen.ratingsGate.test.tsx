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
jest.mock("@/services/api", () => ({
  api: { getReviews: (...a: unknown[]) => mockGetReviews(...a) },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: {} }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
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
