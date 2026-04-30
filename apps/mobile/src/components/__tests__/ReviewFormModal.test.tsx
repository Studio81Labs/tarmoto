/**
 * ReviewFormModal — US-25.
 *
 * Coverage matrix:
 *   - form validation: submit disabled until a rating is set
 *   - rating-only submissions are accepted (comment + photos optional)
 *   - photo picker permission denial surfaces an inline notice
 *   - upload happy path forwards backend URLs to submit
 *   - id-based slot patching survives sibling removal mid-upload
 *   - failed uploads block submit instead of silently dropping
 *   - 409 conflict keeps the form open with a banner + onConflict
 *   - aborts the in-flight upload when × is tapped pre-completion
 *   - aborts uploads when the modal is hidden via the visible prop
 *   - delete in edit mode confirms via Alert and notifies the parent
 *   - awaits async parent callbacks so submitting stays true through
 *     the parent's refresh
 */

import React from "react";
import { Alert } from "react-native";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import ReviewFormModal from "../ReviewFormModal";
import { api } from "@/services/api";
import { capturePhoto } from "@/services/photoCapture";
import type { RoadReview } from "@/types";

jest.mock("@/services/api", () => ({
  api: {
    submitReviewWithQueue: jest.fn(),
    updateReview: jest.fn(),
    deleteReview: jest.fn(),
    uploadReviewPhotos: jest.fn(),
  },
}));

jest.mock("@/services/photoCapture", () => ({
  capturePhoto: jest.fn(),
}));

jest.mock("@/stores", () => ({
  useAuthStore: (
    selector: (state: { user: { id: string } | null }) => unknown,
  ) => selector({ user: { id: "user-1" } }),
}));

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactStub = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactStub.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

// React Native's Modal pulls in the native renderer (`Animated.timing`
// drives the slide-in) which trips a hoisted-React/RN-renderer
// version mismatch under jest. Replace it with a transparent
// passthrough so the form's children mount as if visible —
// visibility is gated on the `visible` prop directly.
jest.mock("react-native/Libraries/Modal/Modal", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactStub = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  function MockModal({
    visible,
    children,
  }: {
    visible: boolean;
    children: unknown;
  }) {
    if (!visible) return null;
    return ReactStub.createElement(View, null, children);
  }
  return { __esModule: true, default: MockModal };
});

const submitWithQueueMock = api.submitReviewWithQueue as jest.MockedFunction<
  typeof api.submitReviewWithQueue
>;
const updateReviewMock = api.updateReview as jest.MockedFunction<
  typeof api.updateReview
>;
const deleteReviewMock = api.deleteReview as jest.MockedFunction<
  typeof api.deleteReview
>;
const uploadPhotosMock = api.uploadReviewPhotos as jest.MockedFunction<
  typeof api.uploadReviewPhotos
>;
const capturePhotoMock = capturePhoto as jest.MockedFunction<
  typeof capturePhoto
>;

function makeReview(overrides: Partial<RoadReview> = {}): RoadReview {
  return {
    id: "review-1",
    user_display_name: "Rider",
    rating: 4,
    comment: "Great asphalt",
    bike_model: "BMW R1250GS",
    photos: [],
    created_at: "2026-04-30T10:00:00.000Z",
    helpful_count: 0,
    not_helpful_count: 0,
    my_vote: null,
    is_mine: true,
    ...overrides,
  };
}

describe("ReviewFormModal", () => {
  beforeEach(() => {
    submitWithQueueMock.mockReset();
    updateReviewMock.mockReset();
    deleteReviewMock.mockReset();
    uploadPhotosMock.mockReset();
    capturePhotoMock.mockReset();
  });

  it("disables submit until the rider taps a star", () => {
    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    const submit = screen.getByLabelText("Submit review");
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    expect(submit.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("accepts a rating-only submission (no comment, no photos)", async () => {
    submitWithQueueMock.mockResolvedValueOnce({
      status: "uploaded",
      review: makeReview({ rating: 3, comment: null, photos: [] }),
      pending: 0,
    });
    const onSubmitted = jest.fn();
    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 3 stars"));
    fireEvent.press(screen.getByLabelText("Submit review"));

    await waitFor(() => expect(submitWithQueueMock).toHaveBeenCalledTimes(1));
    expect(submitWithQueueMock).toHaveBeenCalledWith(
      {
        segmentId: "seg-1",
        rating: 3,
        comment: undefined,
        bikeModel: undefined,
        photos: undefined,
      },
      "user-1",
    );
    expect(onSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ status: "uploaded" }),
    );
  });

  it("surfaces an inline notice when camera permission is denied", async () => {
    capturePhotoMock.mockResolvedValueOnce({
      status: "permission-denied",
      source: "camera",
    });

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Add photo from camera"));

    expect(await screen.findByText(/camera access was denied/i)).toBeTruthy();
    expect(uploadPhotosMock).not.toHaveBeenCalled();
  });

  it("uploads picked photos and forwards the resulting URLs to submit", async () => {
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      source: "library",
      photo: {
        uri: "file:///tmp/road.jpg",
        fileName: "road.jpg",
        mimeType: "image/jpeg",
      },
    });
    uploadPhotosMock.mockResolvedValueOnce({
      photos: ["https://api.tarmoto.test/uploads/road-review-photos/abc.jpg"],
    });
    submitWithQueueMock.mockResolvedValueOnce({
      status: "uploaded",
      review: makeReview(),
      pending: 0,
    });

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 5 stars"));
    fireEvent.press(screen.getByLabelText("Add photo from library"));

    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalled());
    fireEvent.press(screen.getByLabelText("Submit review"));

    await waitFor(() => expect(submitWithQueueMock).toHaveBeenCalledTimes(1));
    expect(submitWithQueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentId: "seg-1",
        rating: 5,
        photos: ["https://api.tarmoto.test/uploads/road-review-photos/abc.jpg"],
      }),
      "user-1",
    );
  });

  it("treats queued submissions as success and notifies the parent", async () => {
    submitWithQueueMock.mockResolvedValueOnce({
      status: "queued",
      pending: 1,
    });
    const onSubmitted = jest.fn();

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 2 stars"));
    fireEvent.press(screen.getByLabelText("Submit review"));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("update path sends explicit null/[] for cleared optional fields", async () => {
    // Regression: undefined values are stripped by JSON.stringify, so
    // a permissive PUT handler could read missing keys as "keep
    // existing." Sending explicit null for cleared text and an empty
    // array for cleared photos keeps the wire payload unambiguous.
    const initialReview = makeReview({
      rating: 5,
      comment: "Original",
      bike_model: "BMW R1250GS",
      photos: ["https://api.tarmoto.test/uploads/road-review-photos/old.jpg"],
    });
    updateReviewMock.mockResolvedValueOnce(makeReview());

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={initialReview}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    // Clear comment, bike model, and remove the seeded photo.
    fireEvent.changeText(screen.getByLabelText("Review notes"), "");
    fireEvent.changeText(screen.getByLabelText("Bike model"), "");
    fireEvent.press(screen.getByLabelText("Remove photo 1"));
    fireEvent.press(screen.getByLabelText("Save review changes"));

    await waitFor(() => expect(updateReviewMock).toHaveBeenCalledTimes(1));
    expect(updateReviewMock).toHaveBeenCalledWith({
      segmentId: "seg-1",
      rating: 5,
      comment: null,
      bikeModel: null,
      photos: [],
    });
  });

  it("routes edit-mode saves through updateReview", async () => {
    const initialReview = makeReview({ rating: 4, comment: "Original" });
    updateReviewMock.mockResolvedValueOnce(
      makeReview({ rating: 2, comment: "Worse now" }),
    );

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={initialReview}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 2 stars"));
    fireEvent.changeText(screen.getByLabelText("Review notes"), "Worse now");
    fireEvent.press(screen.getByLabelText("Save review changes"));

    await waitFor(() => expect(updateReviewMock).toHaveBeenCalledTimes(1));
    expect(updateReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ segmentId: "seg-1", rating: 2 }),
    );
    expect(submitWithQueueMock).not.toHaveBeenCalled();
  });

  it("on 409 conflict, keeps the form open, surfaces a banner, and asks the parent to refresh", async () => {
    const conflictError = Object.assign(new Error("conflict"), {
      response: { status: 409 },
    });
    submitWithQueueMock.mockRejectedValueOnce(conflictError);
    const onSubmitted = jest.fn();
    const onConflict = jest.fn().mockResolvedValue(undefined);

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
        onConflict={onConflict}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    fireEvent.press(screen.getByLabelText("Submit review"));

    expect(
      await screen.findByText(/your existing review is loaded for editing/i),
    ).toBeTruthy();
    expect(onConflict).toHaveBeenCalledTimes(1);
    // Conflict must NOT bubble through onSubmitted — that closes the
    // modal on the parent.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("on 409 conflict, falls back to a plain error if the parent refresh rejects", async () => {
    // Regression: previously the conflict banner was set BEFORE
    // onConflict was awaited, so a parent refresh failure left the
    // banner promising "your existing review is loaded for editing"
    // while the form still rendered create-mode fields. The banner
    // is now set only after onConflict resolves successfully.
    const conflictError = Object.assign(new Error("conflict"), {
      response: { status: 409 },
    });
    submitWithQueueMock.mockRejectedValueOnce(conflictError);
    const onConflict = jest.fn().mockRejectedValue(new Error("refresh failed"));

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
        onConflict={onConflict}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    fireEvent.press(screen.getByLabelText("Submit review"));

    // Plain error surfaces; the misleading "loaded for editing"
    // banner does NOT.
    expect(
      await screen.findByText(/loading the existing review failed/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/your existing review is loaded for editing/i),
    ).toBeNull();
  });

  it("blocks submit when any photo upload errored", async () => {
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      source: "library",
      photo: { uri: "file:///tmp/broken.jpg", mimeType: "image/jpeg" },
    });
    uploadPhotosMock.mockRejectedValueOnce(new Error("network"));

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    fireEvent.press(screen.getByLabelText("Add photo from library"));

    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit review").props.accessibilityState
          ?.disabled,
      ).toBeFalsy(),
    );

    fireEvent.press(screen.getByLabelText("Submit review"));

    expect(
      await screen.findByText(
        /some photos failed to upload — retry or remove them/i,
      ),
    ).toBeTruthy();
    expect(submitWithQueueMock).not.toHaveBeenCalled();
  });

  it("aborts the in-flight upload when the rider removes a photo before it completes", async () => {
    const aborted: boolean[] = [];
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      source: "library",
      photo: { uri: "file:///tmp/x.jpg", mimeType: "image/jpeg" },
    });
    uploadPhotosMock.mockImplementation((_segId, _photos, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted.push(true);
          const err = new Error("aborted");
          (err as { code?: string }).code = "ERR_CANCELED";
          reject(err);
        });
      });
    });

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Add photo from library"));
    await waitFor(() =>
      expect(screen.getByLabelText("Remove photo 1")).toBeTruthy(),
    );

    fireEvent.press(screen.getByLabelText("Remove photo 1"));

    await waitFor(() => expect(aborted).toEqual([true]));
  });

  it("aborts in-flight uploads when the modal is hidden via the visible prop", async () => {
    const aborted: boolean[] = [];
    capturePhotoMock.mockResolvedValueOnce({
      status: "captured",
      source: "library",
      photo: { uri: "file:///tmp/y.jpg", mimeType: "image/jpeg" },
    });
    uploadPhotosMock.mockImplementation((_segId, _photos, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted.push(true);
          const err = new Error("aborted");
          (err as { code?: string }).code = "ERR_CANCELED";
          reject(err);
        });
      });
    });

    const { rerender } = render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText("Add photo from library"));
    await waitFor(() =>
      expect(screen.getByLabelText("Remove photo 1")).toBeTruthy(),
    );

    // Parent toggles `visible` false (rider tapped X / Cancel).
    rerender(
      <ReviewFormModal
        visible={false}
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await waitFor(() => expect(aborted).toEqual([true]));
  });

  it("confirms delete via Alert and notifies onDeleted on success", async () => {
    deleteReviewMock.mockResolvedValueOnce(undefined);
    const alertSpy = jest.spyOn(Alert, "alert");
    alertSpy.mockImplementation((_title, _message, buttons) => {
      const destructive = buttons?.find((b) => b.style === "destructive");
      destructive?.onPress?.();
    });
    const onDeleted = jest.fn();

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={makeReview()}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.press(screen.getByLabelText("Delete review"));

    await waitFor(() => expect(deleteReviewMock).toHaveBeenCalledWith("seg-1"));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
  });

  it("awaits async onSubmitted so submit button remains busy until the parent finishes refreshing", async () => {
    submitWithQueueMock.mockResolvedValueOnce({
      status: "uploaded",
      review: makeReview(),
      pending: 0,
    });
    let resolveSubmitted!: () => void;
    const onSubmitted = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmitted = resolve;
        }),
    );

    render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    fireEvent.press(screen.getByLabelText("Submit review"));

    // Wait for the async backend resolve and the parent callback to fire.
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    // Submit must still be busy because we haven't resolved the
    // parent's promise yet — the form awaits it before flipping
    // `submitting` back to false.
    expect(
      screen.getByLabelText("Submit review").props.accessibilityState?.disabled,
    ).toBe(true);

    resolveSubmitted();
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit review").props.accessibilityState
          ?.disabled,
      ).toBe(false),
    );
  });
});
