/**
 * `sys_accel_collection` defense-in-depth on the sensor service.
 *
 * RideActiveScreen already gates the ride-start call, but `sensorService` is a
 * singleton with other potential callers, so `start()` itself refuses to
 * subscribe when the operator kill switch is force-disabled. This guarantees
 * the raw 50Hz accelerometer/gyro streams never spin up while the switch is off,
 * regardless of call site. The common path (switch ON) must be unaffected.
 */

jest.mock("react-native-sensors", () => ({
  __esModule: true,
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: "accelerometer", gyroscope: "gyroscope" },
}));

jest.mock("../systemSwitchCache", () => ({
  isSystemSwitchEnabled: jest.fn(),
}));

import { accelerometer, gyroscope } from "react-native-sensors";
import { isSystemSwitchEnabled } from "../systemSwitchCache";
import { sensorService } from "../sensors";

const mockedIsEnabled = isSystemSwitchEnabled as jest.MockedFunction<
  typeof isSystemSwitchEnabled
>;
// Cast through `unknown` (as sensors.test.ts does) so we don't reference the
// deprecated rxjs `subscribe` overload the lint rule flags.
const accelSubscribe = (accelerometer as unknown as { subscribe: jest.Mock })
  .subscribe;
const gyroSubscribe = (gyroscope as unknown as { subscribe: jest.Mock })
  .subscribe;

describe("sensorService.start — sys_accel_collection gate", () => {
  afterEach(() => {
    if (sensorService.recording) sensorService.stop();
    accelSubscribe.mockClear();
    gyroSubscribe.mockClear();
    mockedIsEnabled.mockReset();
  });

  it("does not subscribe to the sensor streams when the switch is force-disabled", () => {
    mockedIsEnabled.mockReturnValue(false);

    sensorService.start(() => undefined);

    expect(mockedIsEnabled).toHaveBeenCalledWith("sys_accel_collection");
    expect(sensorService.recording).toBe(false);
    expect(accelSubscribe).not.toHaveBeenCalled();
    expect(gyroSubscribe).not.toHaveBeenCalled();
  });

  it("subscribes normally when the switch is enabled", () => {
    mockedIsEnabled.mockReturnValue(true);

    sensorService.start(() => undefined);

    expect(sensorService.recording).toBe(true);
    expect(accelSubscribe).toHaveBeenCalledTimes(1);
    expect(gyroSubscribe).toHaveBeenCalledTimes(1);
  });
});
