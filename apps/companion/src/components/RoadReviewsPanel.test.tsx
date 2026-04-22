import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

const LONG_REVIEW_COMMENT = "A".repeat(700);

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

  it("hides authoring controls until authenticated ownership data finishes loading", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

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
        data: [
          review({
            id: "review-1",
            rating: 4,
            comment: "Already reviewed from another session.",
            is_mine: true,
          }),
        ],
      });
    });

    expect(
      await screen.findByRole("button", { name: "Edit your review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete your review" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Write a review for this road" }),
    ).not.toBeInTheDocument();
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

    expect(await screen.findByText("4")).toBeInTheDocument();
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
    expect(screen.getByText("3")).toBeInTheDocument();
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

  it("lets an authenticated rider write a review from the panel", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    getReviewsMock.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          rating: 5,
          comment: "Worth the detour.",
          bike_model: "Ducati Monster",
          is_mine: true,
        }),
      ],
    });
    createReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-1",
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Ducati Monster",
        is_mine: true,
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Worth the detour." },
    });
    fireEvent.change(screen.getByLabelText("Bike model"), {
      target: { value: "Ducati Monster" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Worth the detour.",
        bike_model: "Ducati Monster",
      }),
    );
    await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));

    expect(await screen.findByText("Worth the detour.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit your review" }),
    ).toBeInTheDocument();
  });

  it("lets an authenticated rider edit and delete their own review", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    getReviewsMock
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-1",
            rating: 4,
            comment: "Fresh asphalt and smooth sweepers.",
            bike_model: "BMW R1250GS",
            photos: ["https://cdn.example.com/review-1.jpg"],
            is_mine: true,
          }),
        ],
      })
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-1",
            rating: 3,
            comment: "Still good, but a few rough patches now.",
            bike_model: "BMW R1250GS",
            is_mine: true,
          }),
        ],
      })
      .mockResolvedValueOnce({ data: [] });
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
    await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(3));
    expect(
      await screen.findByText(
        "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
      ),
    ).toBeInTheDocument();
  });

  it("preserves full-length comments when editing an existing long review", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    const editedComment = `${LONG_REVIEW_COMMENT}!`;

    getReviewsMock
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-1",
            rating: 4,
            comment: LONG_REVIEW_COMMENT,
            bike_model: "BMW R1250GS",
            is_mine: true,
          }),
        ],
      })
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-1",
            rating: 4,
            comment: editedComment,
            bike_model: "BMW R1250GS",
            is_mine: true,
          }),
        ],
      });
    updateReviewMock.mockResolvedValueOnce({
      data: review({
        id: "review-1",
        rating: 4,
        comment: editedComment,
        bike_model: "BMW R1250GS",
        is_mine: true,
      }),
    });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText(LONG_REVIEW_COMMENT);

    fireEvent.click(screen.getByRole("button", { name: "Edit your review" }));

    expect(screen.getByDisplayValue(LONG_REVIEW_COMMENT)).toBeInTheDocument();
    expect(screen.getByText("700/1000")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: editedComment },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() =>
      expect(updateReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 4,
        comment: editedComment,
        bike_model: "BMW R1250GS",
        photos: ["https://cdn.example.com/review-1.jpg"],
      }),
    );

    expect(await screen.findByText(editedComment)).toBeInTheDocument();
  });

  it("closes the editor and clears stale drafts when the segment changes", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    getReviewsMock.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [],
    });

    const { rerender } = render(
      <RoadReviewsPanel segmentId={firstSegmentId} />,
    );

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Stale draft that should not carry across roads." },
    });

    expect(
      screen.getByRole("button", { name: "Submit review" }),
    ).toBeInTheDocument();

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    expect(
      screen.queryByRole("button", { name: "Submit review" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument();
  });

  it("refetches reviews when authentication changes while the panel is mounted", async () => {
    getReviewsMock
      .mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: false })],
      })
      .mockResolvedValueOnce({
        data: [review({ id: "review-1", is_mine: true })],
      });

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("John Rider");
    expect(
      screen.getByText("Sign in to rate this road and share your feedback."),
    ).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "rider@example.com",
          displayName: "John Rider",
        },
        isAuthenticated: true,
        accessToken: "token-1",
      });
    });

    await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("button", { name: "Edit your review" }),
    ).toBeInTheDocument();
  });

  it("shows delete failures even when the editor is closed", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    getReviewsMock.mockResolvedValueOnce({
      data: [
        review({
          id: "review-1",
          is_mine: true,
        }),
      ],
    });
    deleteReviewMock.mockRejectedValueOnce(
      new Error("Could not delete your review right now."),
    );

    render(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await screen.findByText("Fresh asphalt and smooth sweepers.");

    fireEvent.click(screen.getByRole("button", { name: "Delete your review" }));

    await waitFor(() =>
      expect(deleteReviewMock).toHaveBeenCalledWith(firstSegmentId),
    );
    expect(
      await screen.findByText("Could not delete your review right now."),
    ).toBeInTheDocument();
  });

  it("skips the stale post-submit reload after the rider switches segments", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    let resolveCreate: ((value: { data: RoadReview }) => void) | null = null;

    getReviewsMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
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

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Worth the detour." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenCalledWith(firstSegmentId, {
        rating: 5,
        comment: "Worth the detour.",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );

    await act(async () => {
      resolveCreate?.({
        data: review({
          id: "review-1",
          rating: 5,
          comment: "Worth the detour.",
          is_mine: true,
        }),
      });
    });

    await waitFor(() => expect(getReviewsMock).toHaveBeenCalledTimes(2));
    expect(
      getReviewsMock.mock.calls.filter(([id]) => id === firstSegmentId),
    ).toHaveLength(1);
  });

  it("ignores stale submit errors and keeps the active mutation disabled", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    let rejectFirstCreate: ((error: Error) => void) | null = null;
    let resolveSecondCreate: ((value: { data: RoadReview }) => void) | null =
      null;

    getReviewsMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-2",
            rating: 4,
            comment: "Segment B review",
            is_mine: true,
          }),
        ],
      });
    createReviewMock
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "First segment review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(1, firstSegmentId, {
        rating: 5,
        comment: "First segment review",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Second segment review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(2, secondSegmentId, {
        rating: 4,
        comment: "Second segment review",
      }),
    );

    const submitButton = screen.getByRole("button", { name: "Submit review" });
    expect(submitButton).toBeDisabled();

    await act(async () => {
      rejectFirstCreate?.(new Error("First segment timed out"));
    });

    expect(
      screen.queryByText("First segment timed out"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit review" }),
    ).toBeDisabled();

    await act(async () => {
      resolveSecondCreate?.({
        data: review({
          id: "review-2",
          rating: 4,
          comment: "Segment B review",
          is_mine: true,
        }),
      });
    });

    expect(await screen.findByText("Segment B review")).toBeInTheDocument();
  });

  it("ignores stale submit errors after the rider returns to the same segment", async () => {
    useAuthStore.setState({
      user: {
        id: "user-1",
        email: "rider@example.com",
        displayName: "John Rider",
      },
      isAuthenticated: true,
      accessToken: "token-1",
    });

    let rejectFirstCreate: ((error: Error) => void) | null = null;
    let resolveSecondCreate: ((value: { data: RoadReview }) => void) | null =
      null;

    getReviewsMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          review({
            id: "review-3",
            rating: 5,
            comment: "Returned segment review",
            is_mine: true,
          }),
        ],
      });
    createReviewMock
      .mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Original segment review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(1, firstSegmentId, {
        rating: 5,
        comment: "Original segment review",
      }),
    );

    rerender(<RoadReviewsPanel segmentId={secondSegmentId} />);

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(secondSegmentId),
    );
    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    rerender(<RoadReviewsPanel segmentId={firstSegmentId} />);

    await waitFor(() =>
      expect(getReviewsMock).toHaveBeenLastCalledWith(firstSegmentId),
    );
    await screen.findByText(
      "No reviews yet. Riders will start seeing community feedback here as soon as someone rates this road.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Write a review for this road" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Returned segment review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() =>
      expect(createReviewMock).toHaveBeenNthCalledWith(2, firstSegmentId, {
        rating: 4,
        comment: "Returned segment review",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Submit review" }),
    ).toBeDisabled();

    await act(async () => {
      rejectFirstCreate?.(new Error("Original segment timed out"));
    });

    expect(
      screen.queryByText("Original segment timed out"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit review" }),
    ).toBeDisabled();

    await act(async () => {
      resolveSecondCreate?.({
        data: review({
          id: "review-3",
          rating: 5,
          comment: "Returned segment review",
          is_mine: true,
        }),
      });
    });

    expect(
      await screen.findByText("Returned segment review"),
    ).toBeInTheDocument();
  });
});
