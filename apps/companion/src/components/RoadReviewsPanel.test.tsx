import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  };
}

describe("RoadReviewsPanel", () => {
  const getReviewsMock = vi.mocked(roadsApi.getReviews);
  const createReviewMock = vi.mocked(roadsApi.createReview);
  const voteOnReviewMock = vi.mocked(roadsApi.voteOnReview);
  const clearReviewVoteMock = vi.mocked(roadsApi.clearReviewVote);
  const firstSegmentId = "11111111-1111-4111-8111-111111111111";
  const secondSegmentId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-123",
    });
    getReviewsMock.mockReset();
    createReviewMock.mockReset();
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

  it("submits a new review with photo URLs and prepends it to the panel", async () => {
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
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
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

    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

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
    expect(screen.getByText("1 review")).toBeInTheDocument();
    expect(screen.getByText("5.0 ★ average")).toBeInTheDocument();
  });

  it("blocks invalid photo URLs before calling the backend", async () => {
    getReviewsMock.mockResolvedValueOnce({ data: [] });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Photo URL 1"), {
      target: { value: "http://cdn.example.com/review-1.jpg" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    expect(createReviewMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Photo URLs must start with https://"),
    ).toBeInTheDocument();
  });

  it("resets the review composer when the segment changes", async () => {
    getReviewsMock.mockResolvedValue({ data: [] });

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Draft for the first road" },
    });
    fireEvent.change(screen.getByLabelText("Bike model"), {
      target: { value: "Suzuki V-Strom 800" },
    });
    fireEvent.change(screen.getByLabelText("Photo URL 1"), {
      target: { value: "https://cdn.example.com/first-road.jpg" },
    });

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    expect(screen.getByRole("button", { name: "4 stars" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Your review")).toHaveValue("");
    expect(screen.getByLabelText("Bike model")).toHaveValue("");
    expect(screen.getByLabelText("Photo URL 1")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Post review" }),
    ).toHaveTextContent("Post review");
  });

  it("ignores stale create-review responses after the segment changes", async () => {
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

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Slow response review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Slow response review",
        bike_model: undefined,
        photos: undefined,
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);
    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    expect(resolveCreate).not.toBeNull();
    resolveCreate!({
      data: review({
        id: "stale-review",
        comment: "Slow response review",
        helpful_count: 0,
        not_helpful_count: 0,
      }),
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Post review" }),
      ).toHaveTextContent("Post review"),
    );
    expect(screen.queryByText("Slow response review")).not.toBeInTheDocument();
    expect(screen.getByText("0 reviews")).toBeInTheDocument();
  });

  it("blocks posting while the initial review list is still loading", async () => {
    let resolveReviews: ((value: { data: RoadReview[] }) => void) | null = null;

    getReviewsMock.mockImplementationOnce(
      () =>
        new Promise<{ data: RoadReview[] }>((resolve) => {
          resolveReviews = resolve;
        }),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(screen.getByText("Loading reviews…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post review" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Should not submit yet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    expect(createReviewMock).not.toHaveBeenCalled();

    expect(resolveReviews).not.toBeNull();
    resolveReviews!({ data: [] });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Post review" }),
      ).not.toBeDisabled(),
    );
  });

  it("clears a stale load error after a successful review submit", async () => {
    getReviewsMock.mockRejectedValueOnce(new Error("Could not load reviews."));
    createReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-after-error",
        rating: 5,
        comment: "Recovered after load error",
        helpful_count: 0,
        not_helpful_count: 0,
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    expect(
      await screen.findByText("Could not load reviews."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Recovered after load error" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Recovered after load error",
        bike_model: undefined,
        photos: undefined,
      }),
    );

    expect(
      screen.queryByText("Could not load reviews."),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("Recovered after load error"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 review")).toBeInTheDocument();
  });

  it("keeps a completed review after navigating away and back to the same segment", async () => {
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

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Comes back after navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Comes back after navigation",
        bike_model: undefined,
        photos: undefined,
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

    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "New draft should stay put" },
    });

    expect(resolveCreate).not.toBeNull();
    resolveCreate!({
      data: review({
        id: "review-returned",
        rating: 5,
        comment: "Comes back after navigation",
        helpful_count: 0,
        not_helpful_count: 0,
      }),
    });

    expect(
      await screen.findByText("Comes back after navigation"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 review")).toBeInTheDocument();
    expect(screen.getByLabelText("Your review")).toHaveValue(
      "New draft should stay put",
    );
  });

  it("preserves a created review when the same-segment reload returns stale data", async () => {
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

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Stays after stale reload" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Stays after stale reload",
        bike_model: undefined,
        photos: undefined,
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

    expect(resolveCreate).not.toBeNull();
    resolveCreate!({
      data: review({
        id: "review-after-stale-load",
        rating: 5,
        comment: "Stays after stale reload",
        helpful_count: 0,
        not_helpful_count: 0,
      }),
    });

    expect(resolveReturnedLoad).not.toBeNull();
    resolveReturnedLoad!({ data: [] });

    expect(
      await screen.findByText("Stays after stale reload"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 review")).toBeInTheDocument();
  });

  it("surfaces a create failure after navigating away and back to the same segment", async () => {
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

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Fails after navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Fails after navigation",
        bike_model: undefined,
        photos: undefined,
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

    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Draft after returning" },
    });

    expect(rejectCreate).not.toBeNull();
    rejectCreate!(new Error("Could not post your review."));

    expect(
      await screen.findByText("Could not post your review."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your review")).toHaveValue(
      "Draft after returning",
    );
  });

  it("ignores a stale create failure after a newer same-segment submit succeeds", async () => {
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

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "First attempt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(1, firstSegmentId, {
        rating: 5,
        comment: "First attempt",
        bike_model: undefined,
        photos: undefined,
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

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "Second attempt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(2, firstSegmentId, {
        rating: 5,
        comment: "Second attempt",
        bike_model: undefined,
        photos: undefined,
      }),
    );

    expect(resolveSecondCreate).not.toBeNull();
    resolveSecondCreate!({
      data: review({
        id: "second-attempt-review",
        rating: 5,
        comment: "Second attempt",
        helpful_count: 0,
        not_helpful_count: 0,
      }),
    });

    expect(await screen.findByText("Second attempt")).toBeInTheDocument();

    expect(rejectFirstCreate).not.toBeNull();
    rejectFirstCreate!(new Error("Could not post your review."));

    await waitFor(() =>
      expect(
        screen.queryByText("Could not post your review."),
      ).not.toBeInTheDocument(),
    );
  });

  it("updates review vote counts when riders mark a review helpful", async () => {
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

  it("does not fetch reviews for synthetic planner segment ids", () => {
    render(<RoadReviewsPanel segmentId="seg-1-1" />);

    expect(getReviewsMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Community reviews become available when this segment maps to a saved Tarmoto road.",
      ),
    ).toBeInTheDocument();
  });

  it("hides stale review summary while a new segment is loading", async () => {
    let resolveNext: ((value: { data: RoadReview[] }) => void) | null = null;

    getReviewsMock
      .mockResolvedValueOnce({
        data: [review({ id: "review-1", rating: 5 })],
      })
      .mockImplementationOnce(
        () =>
          new Promise<{ data: RoadReview[] }>((resolve) => {
            resolveNext = resolve;
          }),
      );

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText("1 review");
    expect(screen.getByText("5.0 ★ average")).toBeInTheDocument();

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    expect(screen.getByText("Loading reviews…")).toBeInTheDocument();
    expect(screen.queryByText("1 review")).not.toBeInTheDocument();
    expect(screen.queryByText("5.0 ★ average")).not.toBeInTheDocument();

    await waitFor(() => expect(resolveNext).not.toBeNull());
    resolveNext!({ data: [] });
  });
});
