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

// Kill switches fail SAFE (enabled until a confirmed `force_off`); the real
// hook needs a QueryClientProvider this suite does not set up.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
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
    killSwitch.enabled = false;
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
});
