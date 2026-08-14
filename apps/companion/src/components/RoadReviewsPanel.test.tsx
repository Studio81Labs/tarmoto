import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RoadReviewsPanel } from "./RoadReviewsPanel";
import { ToastHost } from "./ToastHost";
import { roadsApi, type RoadReview } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useToastStore } from "@/stores/toast";

// Both switch families fail SAFE (enabled until a confirmed `force_off`); the
// real hooks need a QueryClientProvider this suite does not set up.
//
// KEYED, and keyed SEPARATELY per registry: this panel reads the
// `community_access` kill switch AND the `sys_poi_ratings` system switch, which
// live in different registry kinds and have different blast radii. A single
// boolean answering for both would let a gate on the wrong one pass (#1204) —
// and here the two are genuinely independent, since `community_access` governs
// author profile links while `sys_poi_ratings` governs the reviews themselves.
const killSwitches = vi.hoisted(
  () => ({ community_access: true }) as Record<string, boolean>,
);
const systemSwitches = vi.hoisted(
  () => ({ sys_poi_ratings: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
  useSystemSwitch: (key: string) => ({
    enabled: systemSwitches[key] ?? true,
    isResolved: true,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      getReviews: vi.fn(),
      createReview: vi.fn(),
      updateReview: vi.fn(),
      deleteReview: vi.fn(),
      uploadReviewPhotos: vi.fn(),
      voteOnReview: vi.fn(),
      clearReviewVote: vi.fn(),
    },
  };
});

function jpegFile(name: string, size = 1024) {
  // Vitest's File implementation reports the byte length passed in the
  // constructor — pad the content to match `size` so the panel's size
  // guard can be exercised with realistic numbers.
  const padding = "x".repeat(Math.max(1, size));
  return new File([padding.slice(0, size)], name, { type: "image/jpeg" });
}

function review(overrides: Partial<RoadReview> & { id: string }): RoadReview {
  return {
    id: overrides.id,
    // user_id is the byline → profile deep-link target (#335). Default
    // to a stable placeholder so tests don't have to set it explicitly.
    // Use `in`-based pickup so callers can pass `user_id: null` to
    // exercise the soft-deleted-author path without the default kicking
    // back in.
    user_id:
      "user_id" in overrides ? (overrides.user_id ?? null) : "user-author",
    user_display_name: overrides.user_display_name ?? "John Rider",
    rating: overrides.rating ?? 4,
    comment: overrides.comment ?? "Fresh asphalt and smooth sweepers.",
    bike_model: overrides.bike_model ?? "BMW R1250GS",
    photos: overrides.photos ?? ["https://cdn.example.com/review-1.jpg"],
    created_at: overrides.created_at ?? "2026-04-22T10:00:00.000Z",
    helpful_count: overrides.helpful_count ?? 3,
    not_helpful_count: overrides.not_helpful_count ?? 1,
    my_vote: overrides.my_vote ?? null,
    is_mine: overrides.is_mine ?? false,
  };
}

function setAuthenticatedViewer() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "rider@example.com",
      displayName: "John Rider",
    },
    isAuthenticated: true,
    accessToken: "token-1",
  });
}

describe("RoadReviewsPanel", () => {
  const getReviewsMock = vi.mocked(roadsApi.getReviews);
  const createReviewMock = vi.mocked(roadsApi.createReview);
  const updateReviewMock = vi.mocked(roadsApi.updateReview);
  const deleteReviewMock = vi.mocked(roadsApi.deleteReview);
  const uploadReviewPhotosMock = vi.mocked(roadsApi.uploadReviewPhotos);
  const voteOnReviewMock = vi.mocked(roadsApi.voteOnReview);
  const clearReviewVoteMock = vi.mocked(roadsApi.clearReviewVote);
  const firstSegmentId = "11111111-1111-4111-8111-111111111111";
  const secondSegmentId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    // Reset BOTH switch maps: the previous single flag was never restored
    // after the community-access test, so its state leaked into whatever ran
    // next.
    killSwitches.community_access = true;
    systemSwitches.sys_poi_ratings = true;
    useToastStore.getState().dismissAll();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
    getReviewsMock.mockReset();
    createReviewMock.mockReset();
    updateReviewMock.mockReset();
    deleteReviewMock.mockReset();
    uploadReviewPhotosMock.mockReset();
    voteOnReviewMock.mockReset();
    clearReviewVoteMock.mockReset();
  });

  it("loads and renders reviews for the selected segment", async () => {
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({ id: "review-1", rating: 5 }),
        review({
          id: "review-2",
          rating: 3,
          user_display_name: "Jane Rider",
          photos: [],
        }),
      ],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(screen.getByText("Loading reviews…")).toBeInTheDocument();

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenCalledWith(firstSegmentId),
    );

    expect(await screen.findByText("John Rider")).toBeInTheDocument();
    expect(screen.getByText("Jane Rider")).toBeInTheDocument();
    expect(screen.getByText("4.0 ★ average")).toBeInTheDocument();
    expect(screen.getByText("2 reviews")).toBeInTheDocument();
  });

  it("reports the live count on load but not on a failed load", async () => {
    const onCountChange = vi.fn();
    getReviewsMock.mockResolvedValueOnce({
      data: [review({ id: "review-1" }), review({ id: "review-2" })],
    });

    const { unmount } = render(
      <RoadReviewsPanel
        segmentId={firstSegmentId}
        onCountChange={onCountChange}
      />,
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(2));
    unmount();

    // A failed load must NOT publish 0 — the parent keeps its own count so a
    // road with reviews doesn't flash "0 reviews" behind the error.
    onCountChange.mockClear();
    getReviewsMock.mockRejectedValueOnce(new Error("Reviews boom"));
    render(
      <RoadReviewsPanel
        segmentId={firstSegmentId}
        onCountChange={onCountChange}
      />,
    );
    expect(
      await screen.findByText("Could not load reviews."),
    ).toBeInTheDocument();
    expect(onCountChange).not.toHaveBeenCalled();
  });

  it("renders the reviewer byline as a profile link for other riders (#335)", async () => {
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          user_id: "rider/with spaces?and#hash",
          user_display_name: "Jane Rider",
        }),
      ],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    const byline = await screen.findByRole("link", { name: "Jane Rider" });
    // user_id is encodeURIComponent'd to keep funky ids safe in the URL.
    expect(byline).toHaveAttribute(
      "href",
      "/community/rider%2Fwith%20spaces%3Fand%23hash",
    );
  });

  it("renders the reviewer byline as plain text when the author is masked (#335)", async () => {
    // Soft-deleted authors come back from the backend with `user_id: null`
    // (paired with the masked "Deleted user" display name) — the card
    // must NOT render a profile link in that case, otherwise tapping the
    // byline would deep-link to a tombstoned profile route.
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          user_id: null,
          user_display_name: "Deleted user",
        }),
      ],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(await screen.findByText("Deleted user")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Deleted user" }),
    ).not.toBeInTheDocument();
  });

  it("renders the reviewer byline as plain text on the viewer's own review (#335)", async () => {
    // A profile link to your own profile from your own review byline
    // would be a useless self-link — the card already shows a "You"
    // chip and edit controls, so collapse to plain text.
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          user_id: "user-1",
          user_display_name: "John Rider",
          is_mine: true,
        }),
      ],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(await screen.findByText("John Rider")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "John Rider" }),
    ).not.toBeInTheDocument();
  });

  it("does not fetch reviews for synthetic planner segment ids", () => {
    render(<RoadReviewsPanel segmentId="seg-1-1" />);

    expect(getReviewsMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Community reviews become available when this segment maps to a saved Tarmoto road.",
      ),
    ).toBeInTheDocument();
  });

  it("requires authentication before showing review composer controls", async () => {
    getReviewsMock.mockResolvedValueOnce({ data: [] });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText(
      "No reviews yet. Riders see community feedback here as soon as someone rates this road.",
    );

    expect(
      screen.getByText("Sign in to rate this road and share your feedback."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Write a review for this road" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Submit review" }),
    ).not.toBeInTheDocument();
  });

  it("hides authoring controls while ownership data is still loading", async () => {
    setAuthenticatedViewer();

    let resolveReviews: ((value: { data: RoadReview[] }) => void) | null = null;
    getReviewsMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview[] }>((resolve) => {
          resolveReviews = resolve;
        }),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(screen.getByText("Loading reviews…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Write a review for this road" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit your review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete your review" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveReviews?.({
        data: [review({ id: "review-1", is_mine: true })],
      });
    });

    expect(
      await screen.findByRole("button", { name: "Edit your review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete your review" }),
    ).toBeInTheDocument();
  });

  it("uploads selected photos, then submits the review with the returned URLs", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] });
    uploadReviewPhotosMock.mockResolvedValueOnce({
      data: {
        photos: [
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-1.jpg",
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-2.jpg",
        ],
      },
    });
    createReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-new",
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Triumph Tiger 900",
        photos: [
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-1.jpg",
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-2.jpg",
        ],
        helpful_count: 0,
        not_helpful_count: 0,
        is_mine: true,
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    expect(screen.getByRole("button", { name: "1 star" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Worth the detour." },
    });
    fireEvent.change(screen.getByLabelText("Bike model"), {
      target: { value: "Triumph Tiger 900" },
    });

    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    const fileA = jpegFile("shot-1.jpg");
    const fileB = jpegFile("shot-2.jpg");
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [fileA, fileB] },
      });
    });

    await waitFor(() =>
      expect(uploadReviewPhotosMock).toHaveBeenCalledWith(firstSegmentId, [
        fileA,
        fileB,
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Triumph Tiger 900",
        photos: [
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-1.jpg",
          "https://app.tarmoto.test/uploads/road-review-photos/seg-1-shot-2.jpg",
        ],
      }),
    );

    expect(await screen.findByText("Worth the detour.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit your review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete your review" }),
    ).toBeInTheDocument();
  });

  it("ignores stale submit responses after the viewer changes on the same segment", async () => {
    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;

    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [],
    });
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "User A review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "User A review",
      }),
    );

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-2",
          email: "other-rider@example.com",
          displayName: "Jane Rider",
        },
        isAuthenticated: true,
        accessToken: "token-2",
      });
    });

    await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "stale-user-review",
          comment: "User A review",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    expect(screen.queryByText("User A review")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Write a review for this road" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit your review" }),
    ).not.toBeInTheDocument();
  });

  it("rejects unsupported file types client-side before sending the upload", async () => {
    // The backend does enforce mimetype but we want a fast inline error so
    // the rider doesn't burn an upload roundtrip on a clearly-wrong file.
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    const gif = new File(["raw"], "anim.gif", { type: "image/gif" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [gif] } });
    });

    expect(uploadReviewPhotosMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Photos must be JPEG, PNG, or WebP images."),
    ).toBeInTheDocument();
  });

  it("ignores uploaded URLs that resolve after the segment changed", async () => {
    // The Codex P2 case: a slow upload completes after the user has
    // already navigated to a different segment. Without parent-side
    // staleness checks the resolved URLs would silently land in the new
    // segment's draft (or, worse, a draft for someone else's review on
    // re-open). The handler must drop the result.
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValue({ data: [] });

    let resolveUpload:
      | ((value: { data: { photos: string[] } }) => void)
      | null = null;
    uploadReviewPhotosMock.mockImplementationOnce(
      () =>
        new Promise<{ data: { photos: string[] } }>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );
    await screen.findByRole("button", { name: "Write a review for this road" });
    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [jpegFile("slow.jpg")] },
      });
    });

    expect(uploadReviewPhotosMock).toHaveBeenCalledWith(firstSegmentId, [
      expect.any(File),
    ]);

    // Switch segments while the upload is in flight.
    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    // Now resolve the original upload — its URL must NOT leak into the
    // second segment's draft.
    await act(async () => {
      resolveUpload?.({
        data: {
          photos: [
            "https://app.tarmoto.test/uploads/road-review-photos/seg-1-stale.jpg",
          ],
        },
      });
    });

    // No editor was opened for the second segment, so re-open it for the
    // first segment and confirm the draft is empty (the stale URL didn't
    // sneak in via the segmentId reset path).
    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Write a review for this road",
      }),
    );
    expect(
      screen.queryByRole("button", { name: /Remove photo/ }),
    ).not.toBeInTheDocument();
  });

  it("ignores uploaded URLs that resolve after the editor was closed and reopened on the same segment", async () => {
    // Close+reopen leaves `editorMode` non-null again, so the bare null
    // check isn't enough on its own — we additionally bump an
    // editor-session counter on every open and close, and the upload
    // guard rejects results whose captured session no longer matches.
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValue({ data: [] });

    let resolveUpload:
      | ((value: { data: { photos: string[] } }) => void)
      | null = null;
    uploadReviewPhotosMock.mockImplementationOnce(
      () =>
        new Promise<{ data: { photos: string[] } }>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await screen.findByRole("button", { name: "Write a review for this road" });

    // Open → upload → cancel → reopen, all on the same segment.
    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [jpegFile("from-canceled-session.jpg")] },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    // The reopened editor is fresh — the in-flight upload from the
    // previous session must not apply its result here.
    await act(async () => {
      resolveUpload?.({
        data: {
          photos: [
            "https://app.tarmoto.test/uploads/road-review-photos/seg-1-canceled.jpg",
          ],
        },
      });
    });

    expect(
      screen.queryByRole("button", { name: /Remove photo/ }),
    ).not.toBeInTheDocument();
  });

  it("ignores uploaded URLs that resolve after the editor was closed", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValue({ data: [] });

    let resolveUpload:
      | ((value: { data: { photos: string[] } }) => void)
      | null = null;
    uploadReviewPhotosMock.mockImplementationOnce(
      () =>
        new Promise<{ data: { photos: string[] } }>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await screen.findByRole("button", { name: "Write a review for this road" });
    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [jpegFile("slow.jpg")] },
      });
    });

    // Close the editor while the upload is mid-flight.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("button", { name: "Submit review" }),
    ).not.toBeInTheDocument();

    // Resolve the upload — the URL should NOT be retained on the draft.
    await act(async () => {
      resolveUpload?.({
        data: {
          photos: [
            "https://app.tarmoto.test/uploads/road-review-photos/seg-1-after-close.jpg",
          ],
        },
      });
    });

    // Re-open the editor: draft should be empty, no thumbnail from the
    // canceled upload.
    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    expect(
      screen.queryByRole("button", { name: /Remove photo/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces an upload error from the backend without blocking later submissions", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] });
    uploadReviewPhotosMock.mockRejectedValueOnce(
      new Error("Photos must be PNG, JPEG, or WebP images"),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    const fileInput = screen.getByLabelText(
      "Select review photos",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [jpegFile("oops.jpg")] },
      });
    });

    expect(
      await screen.findByText("Could not upload photos."),
    ).toBeInTheDocument();
    // After an upload failure the submit button must remain enabled so the
    // rider can fix it (try a different file) and retry without losing the
    // rest of their draft.
    expect(
      screen.getByRole("button", { name: "Submit review" }),
    ).not.toBeDisabled();
  });

  it("edits and deletes the authenticated rider's existing review", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          rating: 4,
          comment: "Fresh asphalt and smooth sweepers.",
          bike_model: "BMW R1250GS",
          is_mine: true,
        }),
      ],
    });
    updateReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-1",
        rating: 3,
        comment: "Still good, but a few rough patches now.",
        bike_model: "BMW R1250GS",
        is_mine: true,
      }),
    });
    deleteReviewMock.mockResolvedValueOnce({ data: undefined });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("Fresh asphalt and smooth sweepers.");

    fireEvent.click(screen.getByRole("button", { name: "Edit your review" }));
    fireEvent.click(screen.getByRole("button", { name: "3 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Still good, but a few rough patches now." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 3,
        comment: "Still good, but a few rough patches now.",
        bike_model: "BMW R1250GS",
        photos: ["https://cdn.example.com/review-1.jpg"],
      }),
    );

    expect(
      await screen.findByText("Still good, but a few rough patches now."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete your review" }));

    await waitFor(() =>
      expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
    );
    expect(
      await screen.findByText(
        "No reviews yet. Riders see community feedback here as soon as someone rates this road.",
      ),
    ).toBeInTheDocument();
  });

  it("preserves an edited review when a same-segment reload returns stale data", async () => {
    setAuthenticatedViewer();
    let resolveUpdate: ((value: { data: RoadReview }) => void) | null = null;
    let resolveReturnedLoad: ((value: { data: RoadReview[] }) => void) | null =
      null;

    getReviewsMock
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-edit-stale",
            comment: "Original pavement report.",
            is_mine: true,
          }),
        ],
      })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview[] }>((resolve) => {
            resolveReturnedLoad = resolve;
          }),
      );
    updateReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText("Original pavement report.");

    fireEvent.click(screen.getByRole("button", { name: "Edit your review" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Edited pavement report." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 4,
        comment: "Edited pavement report.",
        bike_model: "BMW R1250GS",
        photos: ["https://cdn.example.com/review-1.jpg"],
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    await act(async () => {
      resolveUpdate?.({
        data: review({
          id: "review-edit-stale",
          comment: "Edited pavement report.",
          is_mine: true,
        }),
      });
    });

    await act(async () => {
      resolveReturnedLoad?.({
        data: [
          review({
            id: "review-edit-stale",
            comment: "Original pavement report.",
            is_mine: true,
          }),
        ],
      });
    });

    expect(
      await screen.findByText("Edited pavement report."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Original pavement report."),
    ).not.toBeInTheDocument();
  });

  it("keeps a deleted review hidden when a same-segment reload returns stale data", async () => {
    setAuthenticatedViewer();
    let resolveDelete: ((value: { data: undefined }) => void) | null = null;
    let resolveReturnedLoad: ((value: { data: RoadReview[] }) => void) | null =
      null;

    getReviewsMock
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-delete-stale",
            comment: "Will be deleted before stale reload.",
            is_mine: true,
          }),
        ],
      })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview[] }>((resolve) => {
            resolveReturnedLoad = resolve;
          }),
      );
    deleteReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: undefined }>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText("Will be deleted before stale reload.");

    fireEvent.click(screen.getByRole("button", { name: "Delete your review" }));

    await waitFor(() =>
      expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    await act(async () => {
      resolveDelete?.({ data: undefined });
    });

    await act(async () => {
      resolveReturnedLoad?.({
        data: [
          review({
            id: "review-delete-stale",
            comment: "Will be deleted before stale reload.",
            is_mine: true,
          }),
        ],
      });
    });

    expect(
      await screen.findByText(
        "No reviews yet. Riders see community feedback here as soon as someone rates this road.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Will be deleted before stale reload."),
    ).not.toBeInTheDocument();
  });

  it("closes the editor when a delayed delete succeeds after returning to the same segment", async () => {
    setAuthenticatedViewer();
    let resolveDelete: ((value: { data: undefined }) => void) | null = null;

    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-delete-return",
          comment: "Delete me after navigation.",
          is_mine: true,
        }),
      ],
    });
    getReviewsMock.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [
        review({
          id: "review-delete-return",
          comment: "Delete me after navigation.",
          is_mine: true,
        }),
      ],
    });
    deleteReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: undefined }>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText("Delete me after navigation.");

    fireEvent.click(screen.getByRole("button", { name: "Delete your review" }));

    await waitFor(() =>
      expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit your review" }));
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveDelete?.({ data: undefined });
    });

    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        "No reviews yet. Riders see community feedback here as soon as someone rates this road.",
      ),
    ).toBeInTheDocument();
  });

  it("sends an explicit empty photo list when an edit removes all photos", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-photos",
          comment: "Scenic section with a photo.",
          photos: ["https://cdn.example.com/review-photo.jpg"],
          is_mine: true,
        }),
      ],
    });
    updateReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-photos",
        comment: "Scenic section with a photo.",
        photos: [],
        is_mine: true,
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("Scenic section with a photo.");

    fireEvent.click(screen.getByRole("button", { name: "Edit your review" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 4,
        comment: "Scenic section with a photo.",
        bike_model: "BMW R1250GS",
        photos: [],
      }),
    );
  });

  it("suppresses vote controls for reviews authored by the viewer", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({
      data: [review({ id: "review-1", is_mine: true })],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("Fresh asphalt and smooth sweepers.");

    expect(screen.getByText("This is your review.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark this review as helpful" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Mark this review as not helpful",
      }),
    ).not.toBeInTheDocument();
  });

  it("updates review vote counts when riders mark another review helpful", async () => {
    getReviewsMock.mockResolvedValueOnce({
      data: [review({ id: "review-1", helpful_count: 3, my_vote: null })],
    });
    voteOnReviewMock.mockResolvedValueOnce({
      data: {
        helpful_count: 4,
        not_helpful_count: 1,
        my_vote: true,
      },
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("John Rider");

    fireEvent.click(
      screen.getByRole("button", { name: "Mark this review as helpful" }),
    );

    await waitFor(() =>
      expect(voteOnReviewMock).toHaveBeenCalledWith("review-1", true),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove helpful vote" }),
      ).toHaveTextContent("4"),
    );
  });

  it("surfaces vote errors when the backend rejects the action", async () => {
    getReviewsMock.mockResolvedValueOnce({
      data: [review({ id: "review-1", helpful_count: 3, my_vote: null })],
    });
    voteOnReviewMock.mockRejectedValueOnce(
      new Error("Cannot vote on your own review"),
    );

    render(
      <>
        <RoadReviewsPanel segmentId={firstSegmentId} />
        <ToastHost />
      </>,
    );

    await screen.findByText("John Rider");

    fireEvent.click(
      screen.getByRole("button", { name: "Mark this review as helpful" }),
    );

    await waitFor(() =>
      expect(voteOnReviewMock).toHaveBeenCalledWith("review-1", true),
    );

    expect(
      await screen.findByText("Could not submit vote."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mark this review as helpful" }),
    ).toHaveTextContent("3");
  });

  it("ignores stale create-review responses after the segment changes", async () => {
    setAuthenticatedViewer();
    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;

    getReviewsMock.mockResolvedValue({ data: [] });
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Slow response review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Slow response review",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "stale-review",
          comment: "Slow response review",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    expect(screen.queryByText("Slow response review")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Write a review for this road" }),
    ).toBeInTheDocument();
  });

  it("keeps a completed review after navigating away and back to the same segment", async () => {
    setAuthenticatedViewer();
    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;

    getReviewsMock.mockResolvedValue({ data: [] });
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Comes back after navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Comes back after navigation",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "New draft should stay put" },
    });

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "review-returned",
          rating: 5,
          comment: "Comes back after navigation",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    // The editor stays open (now in edit mode) with the user's newer draft
    // preserved...
    expect(screen.getByLabelText("Comment")).toHaveValue(
      "New draft should stay put",
    );
    // ...and the returned review is retained in state. The list is hidden while
    // the editor is open, so close it to confirm the review is still there.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("Comes back after navigation"),
    ).toBeInTheDocument();
  });

  it("switches a returned draft into edit mode after a delayed create establishes ownership", async () => {
    setAuthenticatedViewer();
    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;

    getReviewsMock.mockResolvedValue({ data: [] });
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    updateReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-after-return",
        rating: 5,
        comment: "Refined after the delayed create",
        helpful_count: 0,
        not_helpful_count: 0,
        is_mine: true,
      }),
    });

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Original create request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Original create request",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Refined after the delayed create" },
    });

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "review-after-return",
          rating: 5,
          comment: "Original create request",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    expect(
      await screen.findByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Comment")).toHaveValue(
      "Refined after the delayed create",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Refined after the delayed create",
        photos: [],
      }),
    );
    expect(createReviewMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a created review when the same-segment reload returns stale data", async () => {
    setAuthenticatedViewer();
    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;
    let resolveReturnedLoad: ((value: { data: RoadReview[] }) => void) | null =
      null;

    getReviewsMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview[] }>((resolve) => {
            resolveReturnedLoad = resolve;
          }),
      );
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Stays after stale reload" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Stays after stale reload",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "review-after-stale-load",
          rating: 5,
          comment: "Stays after stale reload",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    await act(async () => {
      resolveReturnedLoad?.({ data: [] });
    });

    expect(
      await screen.findByText("Stays after stale reload"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 review")).toBeInTheDocument();
  });

  it("surfaces a create failure after navigating away and back to the same segment", async () => {
    setAuthenticatedViewer();
    let rejectCreate: ((reason?: unknown) => void) | null = null;

    getReviewsMock.mockResolvedValue({ data: [] });
    createReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview }>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Fails after navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Fails after navigation",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Draft after returning" },
    });

    await act(async () => {
      rejectCreate?.(new Error("Could not save your review."));
    });

    expect(
      await screen.findByText("Could not save your review."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Comment")).toHaveValue(
      "Draft after returning",
    );
  });

  it("ignores a stale create failure after a newer same-segment submit succeeds", async () => {
    setAuthenticatedViewer();
    let rejectFirstCreate: ((reason?: unknown) => void) | null = null;
    let resolveSecondCreate: ((value: { data: RoadReview }) => void) | null =
      null;

    getReviewsMock.mockResolvedValue({ data: [] });
    createReviewMock
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview }>((_resolve, reject) => {
            rejectFirstCreate = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview }>((resolve) => {
            resolveSecondCreate = resolve;
          }),
      );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "First attempt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(1, firstSegmentId, {
        rating: 5,
        comment: "First attempt",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Second attempt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(2, firstSegmentId, {
        rating: 5,
        comment: "Second attempt",
      }),
    );

    await act(async () => {
      resolveSecondCreate?.({
        data: review({
          id: "second-attempt-review",
          rating: 5,
          comment: "Second attempt",
          helpful_count: 0,
          not_helpful_count: 0,
          is_mine: true,
        }),
      });
    });

    expect(await screen.findByText("Second attempt")).toBeInTheDocument();

    await act(async () => {
      rejectFirstCreate?.(new Error("Could not save your review."));
    });

    await waitFor(() =>
      expect(
        screen.queryByText("Could not save your review."),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the reviewer name as plain text when community access is killed", async () => {
    // The review is a road-quality contribution and stays readable; only the
    // navigation into the gated community area goes. Blanking the name would
    // lose attribution the review depends on.
    killSwitches.community_access = false;
    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          user_id: "rider-1",
          user_display_name: "Jane Rider",
        }),
      ],
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(await screen.findByText("Jane Rider")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Jane Rider" })).toBeNull();
  });

  describe("sys_poi_ratings", () => {
    // The backend returns ONLY the viewer's own review while this switch is
    // off (see `ReviewsService.listForSegment`), so the panel's list stops
    // being a community list. Every aggregate derived from it has to go
    // neutral, and the state has to be CLASSIFIED from the switch rather than
    // inferred from an empty array.

    it("hides the compose affordance so the rider never fills a form that 503s", async () => {
      systemSwitches.sys_poi_ratings = false;
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({ data: [] });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      // Positive precondition — the panel really did settle.
      expect(
        await screen.findByText(
          /Community reviews are temporarily unavailable/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Write a review for this road" }),
      ).not.toBeInTheDocument();
    });

    it("keeps DELETE while dropping EDIT, so the own review is never trapped", async () => {
      // `delete` is deliberately left open by the backend; `update` is 503'd.
      // The panel must mirror that asymmetry exactly rather than hiding both.
      systemSwitches.sys_poi_ratings = false;
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Edit your review" }),
      ).not.toBeInTheDocument();
    });

    it("DELETES successfully after a hard reload, not just a live flip", async () => {
      // The reload is what strands the review: a live flip leaves the already
      // -loaded list in memory, so only a fresh mount in the killed state
      // proves the rider can still get their content out.
      systemSwitches.sys_poi_ratings = false;
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });
      deleteReviewMock.mockResolvedValueOnce({ data: undefined } as never);

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);
      const del = await screen.findByRole("button", {
        name: "Delete your review",
      });
      fireEvent.click(del);

      await waitFor(() =>
        expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
      );
    });

    it("says UNAVAILABLE rather than falling through to 'no reviews yet'", async () => {
      // The silent empty state this epic forbids: a road that genuinely has
      // reviews would otherwise be indistinguishable from one that has none.
      systemSwitches.sys_poi_ratings = false;
      getReviewsMock.mockResolvedValueOnce({ data: [] });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      expect(
        await screen.findByText(
          /Community reviews are temporarily unavailable/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/No reviews yet/)).not.toBeInTheDocument();
    });

    it("publishes ZERO, never the own-review count, as the road's total", async () => {
      // `SegmentDetailSidebar` binds `onCountChange` straight to the road's
      // review count, so a one-element own-review array would render "1
      // review" as the COMMUNITY total and overwrite the neutral zero the
      // backend serves.
      systemSwitches.sys_poi_ratings = false;
      setAuthenticatedViewer();
      const onCountChange = vi.fn();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      render(
        <RoadReviewsPanel
          segmentId={firstSegmentId}
          onCountChange={onCountChange}
        />,
      );

      // Precondition: the load settled and the own review really is on screen.
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();
      // ZERO, not silence. Staying silent leaves `SegmentDetailSidebar`
      // showing its pre-flip "N reviews" above a panel that says reviews are
      // unavailable; zero is what the backend's detail block serves while off.
      await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
      expect(onCountChange).not.toHaveBeenCalledWith(1);
      // Neither the header count nor an average derived from one review.
      expect(screen.queryByText("1 review")).not.toBeInTheDocument();
      expect(screen.queryByText(/★ average/)).not.toBeInTheDocument();
    });

    it("REMOVES already-loaded community reviews on a LIVE FLIP", async () => {
      // The hole my first live-flip test missed: the flag query re-renders the
      // panel, but the rows fetched BEFORE the flip are still in state. Without
      // a render-time projection the panel shows "temporarily unavailable" AND
      // then lists the very reviews it just said were unavailable.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValue({
        data: [
          review({ id: "review-1", user_display_name: "Jane Rider" }),
          review({ id: "review-2", is_mine: true }),
        ],
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      expect(await screen.findByText("Jane Rider")).toBeInTheDocument();

      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      // Wait for the REFETCH to land before asserting. The flip re-runs the
      // fetch effect, which clears the list synchronously — so asserting
      // immediately would pass on that clear and never exercise the
      // projection at all. (This test survived a mutation that deleted the
      // projection, which is how the hole surfaced.)
      //
      // The mock deliberately keeps returning the COMMUNITY list here, which
      // is what a stale in-flight response or a not-yet-deployed backend
      // looks like. The projection is what must hold in that case.
      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Delete your review" }),
        ).toBeInTheDocument(),
      );
      // Another rider's review is gone from the DOM, not merely disabled.
      expect(screen.queryByText("Jane Rider")).not.toBeInTheDocument();
      expect(
        screen.getByText(/Community reviews are temporarily unavailable/),
      ).toBeInTheDocument();
    });

    it("renders NO vote controls at all, because only the own review shows", async () => {
      // Under the own-review-only read there is nothing to vote on: a rider
      // cannot vote on their own review. So the guarantee is the ABSENCE of
      // the controls, not a disabled state on them.
      //
      // Withdrawing a vote already cast on someone else's review is therefore
      // unreachable during a pause, even though the backend leaves `clearVote`
      // open for it — filed as #1177. It predates this change: the previous
      // `return []` hid every review too, so nothing regressed.
      systemSwitches.sys_poi_ratings = false;
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      // Precondition: the own review really did render.
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /helpful/i }),
      ).not.toBeInTheDocument();
      expect(voteOnReviewMock).not.toHaveBeenCalled();
    });

    it("keeps vote controls while the switch is ON", async () => {
      // Positive control: without it, "no vote buttons" could pass against a
      // panel that never renders them under any condition.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1" })],
      });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      expect(
        await screen.findByRole("button", {
          name: "Mark this review as helpful",
        }),
      ).toBeInTheDocument();
    });

    it("KEEPS the own review when the off-flip refetch FAILS", async () => {
      // The stranding bug, reintroduced on the error path: the flip re-runs
      // the fetch, and a rejection used to clear the list — taking the only
      // Delete affordance with it, for the rest of the incident, even though
      // the backend leaves DELETE open on purpose.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [
          review({ id: "review-1", user_display_name: "Jane Rider" }),
          review({ id: "review-2", is_mine: true }),
        ],
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      // The refetch triggered by the flip fails.
      getReviewsMock.mockRejectedValueOnce(new Error("Reviews boom"));
      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      // The rider can still get their content out.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Delete your review" }),
        ).toBeInTheDocument(),
      );
      // And the community rows are still gone.
      expect(screen.queryByText("Jane Rider")).not.toBeInTheDocument();
    });

    it("publishes ZERO on an off-flip that lands MID-LOAD", async () => {
      // The distinguishing case. At the instant of a flip the panel usually
      // still has `loading === false`, so even a version that suppressed the
      // zero while loading/erroring would emit one in that intermediate
      // render — which is why the first version of this test passed against
      // the bug. Flipping while a request is genuinely in flight removes that
      // accident: the only chance to publish zero is while `loading` is true.
      setAuthenticatedViewer();
      const onCountChange = vi.fn();
      let resolveFirst: ((v: { data: RoadReview[] }) => void) | undefined;
      getReviewsMock.mockReturnValueOnce(
        new Promise<{ data: RoadReview[] }>((resolve) => {
          resolveFirst = resolve;
        }),
      );

      const { rerender } = render(
        <RoadReviewsPanel
          segmentId={firstSegmentId}
          onCountChange={onCountChange}
        />,
      );
      // Precondition: genuinely mid-load.
      expect(screen.getByText("Loading reviews…")).toBeInTheDocument();
      expect(onCountChange).not.toHaveBeenCalled();

      systemSwitches.sys_poi_ratings = false;
      getReviewsMock.mockRejectedValueOnce(new Error("Reviews boom"));
      rerender(
        <RoadReviewsPanel
          segmentId={firstSegmentId}
          onCountChange={onCountChange}
        />,
      );

      await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));

      // And it stays zero once the failure lands, rather than reverting.
      await act(async () => {
        resolveFirst?.({ data: [review({ id: "review-1" })] });
      });
      expect(onCountChange).not.toHaveBeenCalledWith(1);
    });

    it("CLOSES an already-open editor on the flip", async () => {
      // The one path the entry-button gate cannot reach: the rider opened the
      // composer BEFORE the flip. The fetch/reset effect takes `ratingsEnabled`
      // as a dependency and blanks `editorMode`, so the composer comes down
      // and the unavailable notice takes its place — the rider cannot keep
      // filling in a form that would submit into the 503.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValue({ data: [] });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Write a review for this road",
        }),
      );
      // Precondition: the editor is genuinely open and usable.
      expect(await screen.findByLabelText("Comment")).not.toBeDisabled();

      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() =>
        expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("button", { name: "Submit review" }),
      ).not.toBeInTheDocument();
      // And the rider is told why, rather than the form just vanishing.
      expect(
        await screen.findByText(
          /Community reviews are temporarily unavailable/,
        ),
      ).toBeInTheDocument();
      expect(createReviewMock).not.toHaveBeenCalled();
    });

    it("keeps the delete LOCK across a flip, so it cannot be issued twice", async () => {
      // A flip used to re-run the whole target reset, including
      // `setSubmitting(false)` — re-enabling Delete while the first request
      // was still in flight. A second click then issued a duplicate DELETE,
      // and the 404 it came back with masked the first one's success, leaving
      // the deleted review on screen under an error.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValue({
        data: [review({ id: "review-1", is_mine: true })],
      });
      let releaseDelete: (() => void) | undefined;
      deleteReviewMock.mockReturnValueOnce(
        new Promise<{ data: void }>((resolve) => {
          releaseDelete = () => resolve({ data: undefined });
        }),
      );

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      const del = await screen.findByRole("button", {
        name: "Delete your review",
      });
      fireEvent.click(del);
      await waitFor(() => expect(deleteReviewMock).toHaveBeenCalledTimes(1));

      // Operator flips mid-delete.
      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      // The lock must survive: a second click issues nothing.
      const stillThere = await screen.findByRole("button", {
        name: "Delete your review",
      });
      fireEvent.click(stillThere);
      expect(deleteReviewMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseDelete?.();
      });
    });

    it("keeps a JUST-CREATED review deletable when the off-flip refetch fails", async () => {
      // The retention fallback only ever learned about rows that came back
      // from a GET, so a review created moments before the flip was invisible
      // to it — and a failed refetch dropped the rider's brand-new review's
      // only Delete affordance for the rest of the pause.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({ data: [] });
      createReviewMock.mockResolvedValueOnce({
        data: review({ id: "review-new", is_mine: true }),
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Write a review for this road",
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "5 stars" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
      await waitFor(() => expect(createReviewMock).toHaveBeenCalledTimes(1));
      // Precondition: the new review really is on screen and deletable.
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      getReviewsMock.mockRejectedValueOnce(new Error("Reviews boom"));
      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();
    });

    it("keeps Edit/Delete when the RE-ENABLE fetch fails", async () => {
      // The other direction. This PR made a flip trigger a refetch, so a
      // transient failure on the way back from a pause dropped Edit/Delete and
      // offered "Write a review" — a create that 409s against the review the
      // rider already has.
      setAuthenticatedViewer();
      systemSwitches.sys_poi_ratings = false;
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      // Operator restores ratings; the refetch that triggers fails.
      getReviewsMock.mockRejectedValueOnce(new Error("Reviews boom"));
      systemSwitches.sys_poi_ratings = true;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByText("Could not load reviews."),
      ).toBeInTheDocument();
      // Ownership was confirmed for this segment and viewer; a failed request
      // does not un-confirm it.
      expect(
        screen.getByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Write a review for this road" }),
      ).not.toBeInTheDocument();
      // ...but the retained row must not masquerade as community data.
      expect(screen.queryByText("1 review")).not.toBeInTheDocument();
      expect(screen.queryByText(/★ average/)).not.toBeInTheDocument();
    });

    it("drops a retained review the server no longer returns", async () => {
      // Deleted from another session. The retained row is in the list only
      // because we put it back across the pause, so a SUCCESSFUL response
      // omitting it is authoritative — keeping it renders Edit/Delete over a
      // review that no longer exists, and Delete then 404s.
      setAuthenticatedViewer();
      systemSwitches.sys_poi_ratings = false;
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      // Same target, ratings restored, and the server reports no own review.
      getReviewsMock.mockResolvedValueOnce({ data: [] });
      systemSwitches.sys_poi_ratings = true;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Delete your review" }),
        ).not.toBeInTheDocument(),
      );
      // ...and the rider is offered the create they can now legitimately make.
      expect(
        screen.getByRole("button", { name: "Write a review for this road" }),
      ).toBeInTheDocument();
    });

    it("drops a review created HERE once a later fetch reports it gone", async () => {
      // The retained-row filter alone cannot do this: `mergeFetchedReviews`
      // ends by upserting `localMyReview`, so a review created in this panel
      // and later deleted from another session was put straight back — with
      // Edit/Delete over nothing and a Delete that 404s.
      //
      // Read-after-write is protected separately, by fetch ordering: see
      // "preserves a created review when the same-segment reload returns stale
      // data", where the fetch was already in flight when the create resolved.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({ data: [] });
      createReviewMock.mockResolvedValueOnce({
        data: review({ id: "review-new", is_mine: true }),
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Write a review for this road",
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "5 stars" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
      await waitFor(() => expect(createReviewMock).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      // Deleted elsewhere. This fetch STARTS after the create resolved, so its
      // silence is authoritative.
      getReviewsMock.mockResolvedValueOnce({ data: [] });
      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Delete your review" }),
        ).not.toBeInTheDocument(),
      );
    });

    it("keeps Delete reachable WHILE the off-flip refetch is still running", async () => {
      // The flip starts a GET and the panel enters `loading`, which hid the
      // action row — taking away the only Delete affordance for as long as the
      // request ran, and forever if it hung. The review is already confirmed
      // and its DELETE stays open during a pause, so there is nothing to wait
      // for.
      setAuthenticatedViewer();
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

      const { rerender } = render(
        <RoadReviewsPanel segmentId={firstSegmentId} />,
      );
      expect(
        await screen.findByRole("button", { name: "Delete your review" }),
      ).toBeInTheDocument();

      // The refetch the flip triggers never settles.
      getReviewsMock.mockReturnValueOnce(
        new Promise<{ data: RoadReview[] }>(() => {}),
      );
      systemSwitches.sys_poi_ratings = false;
      rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

      // Precondition: genuinely mid-load.
      expect(await screen.findByText("Loading reviews…")).toBeInTheDocument();
      const del = screen.getByRole("button", { name: "Delete your review" });
      expect(del).toBeInTheDocument();

      // ...and it must WORK. Rendering an enabled-looking control that returns
      // early is worse than hiding it: the rider gets no feedback and no way
      // to withdraw their review while the request hangs.
      deleteReviewMock.mockResolvedValueOnce({ data: undefined });
      fireEvent.click(del);
      await waitFor(() =>
        expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
      );
    });

    it("is independent of community_access", async () => {
      // Two switches, two registries, different blast radii. Killing community
      // access must not take the reviews down, and this suite would pass a
      // gate written against the wrong key without it.
      killSwitches.community_access = false;
      getReviewsMock.mockResolvedValueOnce({
        data: [review({ id: "review-1" })],
      });

      render(<RoadReviewsPanel segmentId={firstSegmentId} />);

      expect(await screen.findByText("John Rider")).toBeInTheDocument();
      expect(
        screen.queryByText(/Community reviews are temporarily unavailable/),
      ).not.toBeInTheDocument();
      expect(screen.getByText("1 review")).toBeInTheDocument();
    });
  });
});
