import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoadReviewsPanel } from "./RoadReviewsPanel";
import { roadsApi, type RoadReview } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      getReviews: vi.fn(),
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
  const voteOnReviewMock = vi.mocked(roadsApi.voteOnReview);
  const clearReviewVoteMock = vi.mocked(roadsApi.clearReviewVote);
  const firstSegmentId = "11111111-1111-4111-8111-111111111111";
  const secondSegmentId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    getReviewsMock.mockReset();
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

    resolveNext?.({ data: [] });
  });
});
