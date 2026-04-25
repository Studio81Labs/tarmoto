/**
 * Photo capture — US-4 AC #4 + AC #9 (camera permission denial path).
 *
 * The Android `PermissionsAndroid` module is mocked so the test owns
 * the request outcome. The real launcher is replaced via the
 * `__setLauncherForTest` seam so `captured` / `cancelled` /
 * `unavailable` branches are all reachable without a native picker.
 */

import { Platform, PermissionsAndroid } from "react-native";
import {
  __resetLauncherForTest,
  __setLauncherForTest,
  capturePhoto,
} from "../photoCapture";

jest.mock("react-native", () => {
  return {
    Platform: { OS: "android" },
    PermissionsAndroid: {
      PERMISSIONS: { CAMERA: "android.permission.CAMERA" },
      RESULTS: {
        GRANTED: "granted",
        DENIED: "denied",
        NEVER_ASK_AGAIN: "never_ask_again",
      },
      request: jest.fn(),
    },
  };
});

const requestMock = PermissionsAndroid.request as jest.MockedFunction<
  typeof PermissionsAndroid.request
>;

describe("photoCapture", () => {
  beforeEach(() => {
    requestMock.mockReset();
    __resetLauncherForTest();
    (Platform as { OS: string }).OS = "android";
  });

  it("returns permission-denied when the rider denies the camera prompt", async () => {
    requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);

    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(result.source).toBe("camera");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("returns permission-denied when the prompt itself throws", async () => {
    requestMock.mockRejectedValueOnce(new Error("native module gone"));

    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("invokes the launcher when camera permission is granted", async () => {
    requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.GRANTED);
    __setLauncherForTest(async () => ({
      status: "captured",
      photo: { uri: "file:///tmp/x.jpg", fileName: "x.jpg" },
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("captured");
    expect(result.photo?.uri).toBe("file:///tmp/x.jpg");
  });

  it("skips the runtime prompt for library access (handled by the picker)", async () => {
    __setLauncherForTest(async () => ({ status: "cancelled" }));

    const result = await capturePhoto("library");

    expect(result.status).toBe("cancelled");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("skips the runtime prompt on iOS where Info.plist drives consent", async () => {
    (Platform as { OS: string }).OS = "ios";
    __setLauncherForTest(async () => ({
      status: "captured",
      photo: { uri: "file:///tmp/y.jpg" },
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("captured");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("forwards the launcher's unavailable status with its reason", async () => {
    requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.GRANTED);
    __setLauncherForTest(async () => ({
      status: "unavailable",
      reason: "feature flag off",
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("feature flag off");
  });
});
