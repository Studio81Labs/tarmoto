/**
 * permissions service — issue #280.
 *
 * Covers:
 *   - rationale Alert shown before the system prompt (Android)
 *   - granted path returns "granted"
 *   - denied path returns "denied"
 *   - never_ask_again triggers the open-settings recovery Alert and
 *     returns "blocked"
 *   - iOS skips the runtime PermissionsAndroid plumbing and trusts the
 *     caller to surface system prompts via the underlying API
 */

import { Alert, Linking, PermissionsAndroid, Platform } from "react-native";
import { requestWithRationale, type PermissionRationale } from "../permissions";

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
    },
    RESULTS: {
      GRANTED: "granted",
      DENIED: "denied",
      NEVER_ASK_AGAIN: "never_ask_again",
    },
    check: jest.fn(),
    request: jest.fn(),
  },
}));

const checkMock = PermissionsAndroid.check as jest.MockedFunction<
  typeof PermissionsAndroid.check
>;
const requestMock = PermissionsAndroid.request as jest.MockedFunction<
  typeof PermissionsAndroid.request
>;
const alertMock = Alert.alert as jest.MockedFunction<typeof Alert.alert>;
const openSettingsMock = Linking.openSettings as jest.MockedFunction<
  typeof Linking.openSettings
>;

const rationale: PermissionRationale = {
  title: "Location for ride recording",
  message: "Tarmoto records GPS while you ride.",
  whyOpenSettings: "Open Settings to allow location.",
};

beforeEach(() => {
  checkMock.mockReset();
  // Default to "not yet granted" so each spec opts in to the
  // already-granted short-circuit explicitly. Without this, every
  // spec would have to remember to seed `check`.
  checkMock.mockResolvedValue(false);
  requestMock.mockReset();
  alertMock.mockReset();
  openSettingsMock.mockReset();
  (Platform as { OS: string }).OS = "android";
});

function answerRationaleWith(button: "Allow" | "Cancel") {
  alertMock.mockImplementationOnce((_title, _message, buttons) => {
    const target = (buttons ?? []).find((b) => b.text === button);
    target?.onPress?.();
  });
}

it("returns granted without showing the rationale when Android already has the permission", async () => {
  // Cached-grant short-circuit (PR #319 review feedback): a rider who
  // granted location on a prior ride should not have to tap through
  // a redundant rationale Alert every time they start a fresh ride.
  checkMock.mockResolvedValueOnce(true);

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("granted");
  expect(alertMock).not.toHaveBeenCalled();
  expect(requestMock).not.toHaveBeenCalled();
});

it("requests the OS permission after the rider taps Allow on the rationale", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.GRANTED);

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("granted");
  expect(alertMock).toHaveBeenCalledTimes(1);
  expect(requestMock).toHaveBeenCalledWith(
    "android.permission.ACCESS_FINE_LOCATION",
  );
});

it("returns denied without calling the OS when the rider cancels the rationale", async () => {
  answerRationaleWith("Cancel");

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("denied");
  expect(requestMock).not.toHaveBeenCalled();
});

it("surfaces a denied result when the OS prompt is dismissed", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("denied");
});

it("opens the app settings when the rider hits never_ask_again", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
  alertMock.mockImplementationOnce((_title, _message, buttons) => {
    const settings = (buttons ?? []).find((b) => b.text === "Open Settings");
    settings?.onPress?.();
  });

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("blocked");
  expect(openSettingsMock).toHaveBeenCalledTimes(1);
});

it("skips the runtime PermissionsAndroid call on iOS and reports granted optimistically", async () => {
  (Platform as { OS: string }).OS = "ios";
  answerRationaleWith("Allow");

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("granted");
  expect(requestMock).not.toHaveBeenCalled();
});
