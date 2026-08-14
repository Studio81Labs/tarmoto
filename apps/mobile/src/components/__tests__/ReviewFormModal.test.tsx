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
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import ReviewFormModal from "../ReviewFormModal";
import { ApiError, api } from "@/services/api";
import { capturePhoto } from "@/services/photoCapture";
import type { RoadReview } from "@/types";

jest.mock("@/services/api", () => ({
  api: {
    submitReviewWithQueue: jest.fn(),
    updateReview: jest.fn(),
    deleteReview: jest.fn(),
    uploadReviewPhotos: jest.fn(),
  },
  // The component narrows caught errors with `instanceof ApiError`;
  // the mock must expose a real constructor so the check doesn't
  // throw "right-hand side is not callable" on rejected promises.
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
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

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
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
    user_id: "user-1",
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

  it("disables submit until the rider taps a star", async () => {
    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    const submit = screen.getByLabelText("Submit review");
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    expect(submit.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("accepts a rating-only submission (no comment, no photos)", async () => {
    submitWithQueueMock.mockResolvedValueOnce({
      status: "uploaded",
      review: makeReview({ rating: 3, comment: null, photos: [] }),
      pending: 0,
    });
    const onSubmitted = jest.fn();
    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 3 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Add photo from camera"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 5 stars"));
    await fireEvent.press(screen.getByLabelText("Add photo from library"));

    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalled());
    await fireEvent.press(screen.getByLabelText("Submit review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 2 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={initialReview}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    // Clear comment, bike model, and remove the seeded photo.
    await fireEvent.changeText(screen.getByLabelText("Review notes"), "");
    await fireEvent.changeText(screen.getByLabelText("Bike model"), "");
    await fireEvent.press(screen.getByLabelText("Remove photo 1"));
    await fireEvent.press(screen.getByLabelText("Save review changes"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={initialReview}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 2 stars"));
    await fireEvent.changeText(
      screen.getByLabelText("Review notes"),
      "Worse now",
    );
    await fireEvent.press(screen.getByLabelText("Save review changes"));

    await waitFor(() => expect(updateReviewMock).toHaveBeenCalledTimes(1));
    expect(updateReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ segmentId: "seg-1", rating: 2 }),
    );
    expect(submitWithQueueMock).not.toHaveBeenCalled();
  });

  it("on 409 conflict, keeps the form open, surfaces a banner, and asks the parent to refresh", async () => {
    const conflictError = new ApiError("conflict", 409, null);
    submitWithQueueMock.mockRejectedValueOnce(conflictError);
    const onSubmitted = jest.fn();
    const onConflict = jest.fn().mockResolvedValue(true);

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
        onConflict={onConflict}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

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
    const conflictError = new ApiError("conflict", 409, null);
    submitWithQueueMock.mockRejectedValueOnce(conflictError);
    const onConflict = jest.fn().mockRejectedValue(new Error("refresh failed"));

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
        onConflict={onConflict}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

    // Plain error surfaces; the misleading "loaded for editing"
    // banner does NOT.
    expect(
      await screen.findByText(/loading the existing review failed/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/your existing review is loaded for editing/i),
    ).toBeNull();
  });

  it("on 409 conflict, falls back to a plain error if onConflict reports failure (returns false)", async () => {
    // The parent's segment refresh helper silently swallows fetch
    // errors, so `onConflict` returning `false` is the only signal
    // that the existing review failed to load. The form must NOT
    // show the "loaded for editing" banner in that case.
    const conflictError = new ApiError("conflict", 409, null);
    submitWithQueueMock.mockRejectedValueOnce(conflictError);
    const onConflict = jest.fn().mockResolvedValue(false);

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
        onConflict={onConflict}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    await fireEvent.press(screen.getByLabelText("Add photo from library"));

    await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByLabelText("Submit review").props.accessibilityState
          ?.disabled,
      ).toBeFalsy(),
    );

    await fireEvent.press(screen.getByLabelText("Submit review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Add photo from library"));
    await waitFor(() =>
      expect(screen.getByLabelText("Remove photo 1")).toBeTruthy(),
    );

    await fireEvent.press(screen.getByLabelText("Remove photo 1"));

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

    const { rerender } = await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Add photo from library"));
    await waitFor(() =>
      expect(screen.getByLabelText("Remove photo 1")).toBeTruthy(),
    );

    // Parent toggles `visible` false (rider tapped X / Cancel).
    await rerender(
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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={makeReview()}
        onClose={jest.fn()}
        onSubmitted={jest.fn()}
        onDeleted={onDeleted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Delete review"));

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

    await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));
    await fireEvent.press(screen.getByLabelText("Submit review"));

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

  it("does not clobber unsaved input if initialReview changes while the form is open", async () => {
    // Regression: the parent's mount-time queue drain can flush a
    // previously-queued review for the current segment and chain
    // through `onSegmentChanged` → `setMyReview(...)`, flipping
    // `initialReview` from null to a fresh review while the rider is
    // mid-typing. Without this guard, the seeding effect would silently
    // overwrite their unsaved input.
    const onSubmitted = jest.fn();
    const { rerender } = await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={null}
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 5 stars"));
    await fireEvent.changeText(
      screen.getByLabelText("Review notes"),
      "Newly composed note",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Bike model"),
      "Yamaha MT-09",
    );

    await rerender(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={makeReview({
          rating: 1,
          comment: "Old flushed note",
          bike_model: "Honda Africa Twin",
        })}
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    expect(screen.getByLabelText("Review notes").props.value).toBe(
      "Newly composed note",
    );
    expect(screen.getByLabelText("Bike model").props.value).toBe(
      "Yamaha MT-09",
    );
  });

  it("keeps form in create mode when initialReview flips mid-session (no updateReview, no Delete button)", async () => {
    // Regression: the field-state guard above stops the rider's input
    // from being clobbered, but `isEditing` was previously derived
    // from the live `initialReview` prop and would still flip to
    // true. That routed Submit through `api.updateReview` (live-only,
    // no offline queue) and silently surfaced a Delete affordance.
    // `isEditing` now ticks alongside the field seed so the mode
    // matches the values actually shown in the form.
    submitWithQueueMock.mockResolvedValueOnce({
      status: "uploaded",
      review: makeReview(),
      pending: 0,
    });
    const onSubmitted = jest.fn();
    const { rerender } = await render(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={null}
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Set rating to 4 stars"));

    // Mid-session prop flip — drain landed a flushed review into the
    // parent's `myReview` while the form is still open.
    await rerender(
      <ReviewFormModal
        visible
        segmentId="seg-1"
        initialReview={makeReview({ rating: 1, comment: "Old flushed note" })}
        onClose={jest.fn()}
        onSubmitted={onSubmitted}
      />,
    );

    // Delete button must not surface — the rider opened in create mode
    // and never asked to edit.
    expect(screen.queryByLabelText("Delete review")).toBeNull();
    // Submit button stays in create-mode label.
    expect(screen.getByLabelText("Submit review")).toBeTruthy();
    expect(screen.queryByLabelText("Save review changes")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Submit review"));

    await waitFor(() => expect(submitWithQueueMock).toHaveBeenCalledTimes(1));
    // Routes through the offline-aware create path, NOT updateReview.
    expect(updateReviewMock).not.toHaveBeenCalled();
  });

  describe("sys_poi_ratings off (ratingsEnabled=false)", () => {
    // The backend's asymmetry, which this modal has to mirror exactly:
    // `create`/`update` 503 while the switch is off, but `delete` is
    // deliberately left open — and on mobile this modal is the ONLY path to
    // it. So the form goes read-only rather than unreachable.

    it("blocks SAVE so the rider cannot submit into a 503", async () => {
      const initialReview = makeReview({ rating: 5, comment: "Original" });

      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={initialReview}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      const save = screen.getByLabelText("Save review changes");
      expect(save.props.accessibilityState?.disabled).toBe(true);
      await fireEvent.press(save);
      expect(updateReviewMock).not.toHaveBeenCalled();
    });

    it("KEEPS delete reachable — a kill switch must not trap user content", async () => {
      const initialReview = makeReview({ rating: 5 });
      const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={initialReview}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
          onDeleted={jest.fn()}
        />,
      );

      const del = screen.getByLabelText("Delete review");
      expect(del.props.accessibilityState?.disabled).not.toBe(true);
      await fireEvent.press(del);
      // Reaches the confirmation, which is where the DELETE is issued from.
      expect(alertSpy).toHaveBeenCalled();
      alertSpy.mockRestore();
    });

    it("explains why saving is off", async () => {
      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5 })}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );
      expect(
        screen.getByText(/Reviews are temporarily unavailable/),
      ).toBeTruthy();
    });

    it("makes the form genuinely READ-ONLY, not just unsavable", async () => {
      // Disabling only Save leaves stars, text and photo controls live — a
      // rider can spend real effort on changes that can never be saved, and
      // the photo picker actually CALLS the upload endpoint and gets a 503.
      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5, comment: "Original" })}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      expect(screen.getByLabelText("Review notes").props.editable).toBe(false);
      expect(screen.getByLabelText("Bike model").props.editable).toBe(false);
      const star = screen.getByLabelText("Set rating to 3 stars");
      expect(star.props.accessibilityState?.disabled).toBe(true);

      // The photo picker is the one that reaches the network.
      await fireEvent.press(screen.getByLabelText("Add photo from library"));
      expect(capturePhotoMock).not.toHaveBeenCalled();
    });

    it("leaves the form editable while the switch is ON", async () => {
      // Positive control for the assertions above.
      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5, comment: "Original" })}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );
      expect(screen.getByLabelText("Review notes").props.editable).not.toBe(
        false,
      );
      expect(
        screen.getByLabelText("Set rating to 3 stars").props.accessibilityState
          ?.disabled,
      ).not.toBe(true);
    });

    it("does not upload a photo picked BEFORE the flip but returned after", async () => {
      // The native picker can sit open across an operator flip. `readOnly`
      // only stops future presses; this closure has already started, and its
      // continuation would upload into the gated endpoint — taking a 503 the
      // rider cannot clear from a form that is now read-only, or succeeding
      // and orphaning a photo on a review that can never be saved.
      let releasePicker: ((v: unknown) => void) | undefined;
      capturePhotoMock.mockReturnValueOnce(
        new Promise((resolve) => {
          releasePicker = resolve;
        }) as never,
      );

      const view = await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5 })}
          ratingsEnabled
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      // Picker opens while the switch is still on.
      await fireEvent.press(screen.getByLabelText("Add photo from library"));
      expect(capturePhotoMock).toHaveBeenCalledTimes(1);

      // Operator flips; the modal re-renders read-only. Awaited — `render` and
      // `rerender` are async in this version, and without it the effect that
      // publishes the new value to the ref has not run when the picker
      // resolves below.
      await view.rerender(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5 })}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      // Only now does the rider finish choosing a photo.
      await act(async () => {
        releasePicker?.({
          status: "success",
          photo: {
            uri: "file:///tmp/p.jpg",
            name: "p.jpg",
            type: "image/jpeg",
          },
        });
      });

      expect(uploadPhotosMock).not.toHaveBeenCalled();
    });

    it("ABORTS an upload already in flight when the switch flips off", async () => {
      // An upload that completes after the flip lands a photo on a review the
      // rider can no longer save — and cannot remove from a read-only form.
      // That is an orphan on the server, so the request is cancelled.
      capturePhotoMock.mockResolvedValueOnce({
        status: "success",
        photo: { uri: "file:///tmp/p.jpg", name: "p.jpg", type: "image/jpeg" },
      } as never);
      uploadPhotosMock.mockReturnValueOnce(
        new Promise(() => {
          /* never settles: the upload is still in flight */
        }) as never,
      );

      const view = await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5 })}
          ratingsEnabled
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );
      await fireEvent.press(screen.getByLabelText("Add photo from library"));
      await waitFor(() => expect(uploadPhotosMock).toHaveBeenCalledTimes(1));

      const signal = (
        uploadPhotosMock.mock.calls[0]?.[2] as { signal: AbortSignal }
      ).signal;
      // Precondition: it really was in flight and un-aborted.
      expect(signal.aborted).toBe(false);

      await view.rerender(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={makeReview({ rating: 5 })}
          ratingsEnabled={false}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      expect(signal.aborted).toBe(true);
    });

    it("leaves SAVE working while the switch is on", async () => {
      // The positive control: without it the assertions above could pass
      // against a form that was broken for some unrelated reason.
      const initialReview = makeReview({ rating: 5, comment: "Original" });
      updateReviewMock.mockResolvedValueOnce(makeReview());

      await render(
        <ReviewFormModal
          visible
          segmentId="seg-1"
          initialReview={initialReview}
          onClose={jest.fn()}
          onSubmitted={jest.fn()}
        />,
      );

      await fireEvent.press(screen.getByLabelText("Save review changes"));
      await waitFor(() => expect(updateReviewMock).toHaveBeenCalledTimes(1));
      expect(
        screen.queryByText(/Reviews are temporarily unavailable/),
      ).toBeNull();
    });
  });
});
