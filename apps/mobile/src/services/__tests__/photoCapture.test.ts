/**
 * Photo capture — US-4 AC #4 + AC #9 (camera permission denial path)
 * + US-280 (open-settings recovery on never_ask_again).
 *
 * The permissions service is mocked so tests own the rationale outcome
 * end-to-end without going through the platform `Alert`. The launcher
 * is replaced via `__setLauncherForTest` so `captured` / `cancelled` /
 * `unavailable` branches are reachable without a native picker.
 */

import { Platform } from "react-native";
import {
  __resetLauncherForTest,
  __setLauncherForTest,
  capturePhoto,
} from "../photoCapture";
import { requestWithRationale } from "../permissions";

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  PermissionsAndroid: {
    PERMISSIONS: { CAMERA: "android.permission.CAMERA" },
  },
}));
jest.mock("../permissions", () => ({
  requestWithRationale: jest.fn(),
}));

const requestMock = requestWithRationale as jest.MockedFunction<
  typeof requestWithRationale
>;

describe("photoCapture", () => {
  beforeEach(() => {
    requestMock.mockReset();
    __resetLauncherForTest();
    (Platform as { OS: string }).OS = "android";
  });

  it("returns permission-denied when the rider declines the rationale", async () => {
    requestMock.mockResolvedValueOnce("denied");
    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(result.source).toBe("camera");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("returns permission-denied when the OS reports the prompt is blocked", async () => {
    requestMock.mockResolvedValueOnce("blocked");
    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("invokes the launcher when permission is granted", async () => {
    requestMock.mockResolvedValueOnce("granted");
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
    requestMock.mockResolvedValueOnce("granted");
    __setLauncherForTest(async () => ({
      status: "unavailable",
      reason: "feature flag off",
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("feature flag off");
  });
});
