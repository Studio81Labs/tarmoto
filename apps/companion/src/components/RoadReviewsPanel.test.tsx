import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RoadReviewsPanel } from "./RoadReviewsPanel";
import { roadsApi, type RoadReview } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      getReviews: vi.fn(),
      createReview: vi.fn(),
      updateReview: vi.fn(),
      deleteReview: vi.fn(),
      voteOnReview: vi.fn(),
      clearReviewVote: vi.fn(),
    },
  };
});

function review(overrides: Partial<RoadReview> & { id: string }): RoadReview {
  return {
    id: overrides.id,
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
  const voteOnReviewMock = vi.mocked(roadsApi.voteOnReview);
  const clearReviewVoteMock = vi.mocked(roadsApi.clearReviewVote);
  const firstSegmentId = "11111111-1111-4111-8111-111111111111";
  const secondSegmentId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
    getReviewsMock.mockReset();
    createReviewMock.mockReset();
    updateReviewMock.mockReset();
    deleteReviewMock.mockReset();
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
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
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

  it("submits a new review with photo URLs and switches to edit controls", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] });
    createReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-new",
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Triumph Tiger 900",
        photos: [
          "https://cdn.example.com/review-new-1.jpg",
          "https://cdn.example.com/review-new-2.jpg",
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
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Worth the detour." },
    });
    fireEvent.change(screen.getByLabelText("Bike model"), {
      target: { value: "Triumph Tiger 900" },
    });
    fireEvent.change(screen.getByLabelText("Photo URL 1"), {
      target: { value: "https://cdn.example.com/review-new-1.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add another photo" }));
    fireEvent.change(screen.getByLabelText("Photo URL 2"), {
      target: { value: "https://cdn.example.com/review-new-2.jpg" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Triumph Tiger 900",
        photos: [
          "https://cdn.example.com/review-new-1.jpg",
          "https://cdn.example.com/review-new-2.jpg",
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

  it("blocks invalid photo URLs before calling the backend", async () => {
    setAuthenticatedViewer();
    getReviewsMock.mockResolvedValueOnce({ data: [] });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByRole("button", { name: "Write a review for this road" });

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Photo URL 1"), {
      target: { value: "http://cdn.example.com/review-1.jpg" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    expect(createReviewMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Photo URLs must start with https://"),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

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
        "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
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
    fireEvent.change(screen.getByLabelText("Photo URL 1"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

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

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("John Rider");

    fireEvent.click(
      screen.getByRole("button", { name: "Mark this review as helpful" }),
    );

    await waitFor(() =>
      expect(voteOnReviewMock).toHaveBeenCalledWith("review-1", true),
    );

    expect(
      await screen.findByText("Cannot vote on your own review"),
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

    expect(
      await screen.findByText("Comes back after navigation"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Comment")).toHaveValue(
      "New draft should stay put",
    );
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
});
