import { Platform } from "react-native";
import {
  checkNotifications,
  requestNotifications,
  RESULTS,
} from "react-native-permissions";
import {
  __resetPushRegistrationForTesting,
  registerForPush,
  type PushRegistrationApi,
} from "../pushRegistration";
import { requestWithRationale } from "../permissions";

const mockGetToken = jest.fn();
const mockOnTokenRefresh = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock("react-native", () => ({
  Platform: { OS: "android", Version: 32 },
  PermissionsAndroid: {
    PERMISSIONS: {
      POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS",
    },
  },
}));

jest.mock("@react-native-firebase/messaging", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getToken: mockGetToken,
    onTokenRefresh: mockOnTokenRefresh,
  })),
}));

jest.mock("react-native-device-info", () => ({
  __esModule: true,
  default: { getReadableVersion: jest.fn(() => "1.0.0.1") },
}));

jest.mock("react-native-permissions", () => ({
  RESULTS: { GRANTED: "granted", LIMITED: "limited" },
  checkNotifications: jest.fn(),
  requestNotifications: jest.fn(),
}));

jest.mock("../permissions", () => ({
  requestWithRationale: jest.fn(),
}));

const requestNotificationsMock = requestNotifications as jest.MockedFunction<
  typeof requestNotifications
>;
const checkNotificationsMock = checkNotifications as jest.MockedFunction<
  typeof checkNotifications
>;
const requestWithRationaleMock = requestWithRationale as jest.MockedFunction<
  typeof requestWithRationale
>;

function setAndroidApiLevel(level: number): void {
  (Platform as unknown as { OS: string; Version: number }).OS = "android";
  (Platform as unknown as { OS: string; Version: number }).Version = level;
}

function createApi(): jest.Mocked<PushRegistrationApi> {
  return {
    registerDevice: jest.fn().mockResolvedValue(undefined),
    unregisterDevice: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  __resetPushRegistrationForTesting();
  jest.clearAllMocks();
  setAndroidApiLevel(32);
  mockGetToken.mockResolvedValue("fcm-token");
  mockOnTokenRefresh.mockReturnValue(mockUnsubscribe);
  checkNotificationsMock.mockResolvedValue({
    status: RESULTS.GRANTED,
    settings: {},
  });
  requestNotificationsMock.mockResolvedValue({
    status: RESULTS.GRANTED,
    settings: {},
  });
  requestWithRationaleMock.mockResolvedValue("granted");
});

it("registers on Android before API 33 without requesting POST_NOTIFICATIONS", async () => {
  const api = createApi();
  requestWithRationaleMock.mockResolvedValue("denied");

  await registerForPush(api);

  expect(requestWithRationaleMock).not.toHaveBeenCalled();
  expect(checkNotificationsMock).toHaveBeenCalledTimes(1);
  expect(requestNotificationsMock).not.toHaveBeenCalled();
  expect(api.registerDevice).toHaveBeenCalledWith({
    platform: "android",
    token: "fcm-token",
    app_version: "1.0.0.1",
  });
});

it("retains the POST_NOTIFICATIONS rationale gate on Android API 33+", async () => {
  setAndroidApiLevel(33);
  const api = createApi();
  requestWithRationaleMock.mockResolvedValue("denied");

  await registerForPush(api);

  expect(requestWithRationaleMock).toHaveBeenCalledWith(
    expect.objectContaining({
      androidPermission: "android.permission.POST_NOTIFICATIONS",
    }),
  );
  expect(requestNotificationsMock).not.toHaveBeenCalled();
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(api.registerDevice).not.toHaveBeenCalled();
});
