import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MyReviewVotesSection } from "./MyReviewVotesSection";
import { ToastHost } from "./ToastHost";
import { roadsApi, type MyReviewVote } from "@/lib/api";
import { useToastStore } from "@/stores/toast";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: {
      getMyReviewVotes: vi.fn(),
      clearReviewVote: vi.fn(),
    },
  };
});

function vote(
  overrides: Partial<MyReviewVote> & { review_id: string },
): MyReviewVote {
  return {
    review_id: overrides.review_id,
    is_helpful: overrides.is_helpful ?? true,
    voted_at: overrides.voted_at ?? "2026-08-01T09:30:00.000Z",
    road_segment_id:
      overrides.road_segment_id ?? "33333333-3333-4333-8333-333333333333",
    // `in`-based pickup so callers can pass explicit nulls to exercise the
    // road-label fallbacks without the default kicking back in.
    road_name:
      "road_name" in overrides
        ? (overrides.road_name ?? null)
        : "Passo dello Stelvio",
    road_number:
      "road_number" in overrides ? (overrides.road_number ?? null) : "SS38",
  };
}

describe("MyReviewVotesSection", () => {
  const getMyReviewVotesMock = vi.mocked(roadsApi.getMyReviewVotes);
  const clearReviewVoteMock = vi.mocked(roadsApi.clearReviewVote);

  beforeEach(() => {
    useToastStore.getState().dismissAll();
    getMyReviewVotesMock.mockReset();
    clearReviewVoteMock.mockReset();
  });

  it("lists the rider's earlier votes and withdraws one via the vote-clearing endpoint", async () => {
    getMyReviewVotesMock.mockResolvedValueOnce({
      data: [
        vote({ review_id: "review-1" }),
        vote({
          review_id: "review-2",
          is_helpful: false,
          road_name: "Grossglockner",
        }),
      ],
    });
    clearReviewVoteMock.mockResolvedValueOnce({
      data: { helpful_count: 0, not_helpful_count: 0, my_vote: null },
    });

    render(<MyReviewVotesSection />);

    expect(
      await screen.findByText("Your votes on community reviews"),
    ).toBeInTheDocument();
    expect(screen.getByText("Passo dello Stelvio")).toBeInTheDocument();
    expect(screen.getByText("Grossglockner")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Withdraw your vote on Passo dello Stelvio",
      }),
    );

    await waitFor(() =>
      expect(clearReviewVoteMock).toHaveBeenCalledWith("review-1"),
    );
    // The withdrawn row leaves the list; the other vote stays withdrawable.
    await waitFor(() =>
      expect(screen.queryByText("Passo dello Stelvio")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Grossglockner")).toBeInTheDocument();
  });

  it("renders nothing when the rider has no votes", async () => {
    getMyReviewVotesMock.mockResolvedValueOnce({ data: [] });

    const { container } = render(<MyReviewVotesSection />);

    await waitFor(() => expect(getMyReviewVotesMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the row and surfaces a toast when the withdrawal fails", async () => {
    getMyReviewVotesMock.mockResolvedValueOnce({
      data: [vote({ review_id: "review-1" })],
    });
    clearReviewVoteMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <>
        <MyReviewVotesSection />
        <ToastHost />
      </>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw your vote on Passo dello Stelvio",
      }),
    );

    expect(
      await screen.findByText("Could not withdraw your vote."),
    ).toBeInTheDocument();
    // The vote is still listed — a failed withdrawal must not hide the row
    // it exists to withdraw — and the button is usable again for a retry.
    expect(screen.getByText("Passo dello Stelvio")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Withdraw your vote on Passo dello Stelvio",
      }),
    ).toBeEnabled();
  });

  it("shows an error instead of silently hiding votes when the listing fails", async () => {
    getMyReviewVotesMock.mockRejectedValueOnce(new Error("offline"));

    render(<MyReviewVotesSection />);

    expect(
      await screen.findByText("Could not load your votes."),
    ).toBeInTheDocument();
  });

  it("falls back to the road number, then to the unnamed-road label", async () => {
    getMyReviewVotesMock.mockResolvedValueOnce({
      data: [
        vote({ review_id: "review-1", road_name: null }),
        vote({ review_id: "review-2", road_name: null, road_number: null }),
      ],
    });

    render(<MyReviewVotesSection />);

    expect(await screen.findByText("SS38")).toBeInTheDocument();
    expect(screen.getByText("Unnamed road")).toBeInTheDocument();
  });
});
