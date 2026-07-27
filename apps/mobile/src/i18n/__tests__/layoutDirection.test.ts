import { syncLayoutDirection } from "../layoutDirection";

describe("syncLayoutDirection", () => {
  const manager = () => ({
    allowRTL: jest.fn(),
    forceRTL: jest.fn(),
    isRTL: false,
    swapLeftAndRightInRTL: jest.fn(),
  });

  it("enables RTL support without restarting an already-LTR app", () => {
    const nativeManager = manager();
    expect(syncLayoutDirection("ltr", nativeManager)).toBe(true);
    expect(nativeManager.allowRTL).toHaveBeenCalledWith(true);
    expect(nativeManager.swapLeftAndRightInRTL).toHaveBeenCalledWith(true);
    expect(nativeManager.forceRTL).not.toHaveBeenCalled();
  });

  it("requests native RTL and reports that a restart is required", () => {
    const nativeManager = manager();
    expect(syncLayoutDirection("rtl", nativeManager)).toBe(false);
    expect(nativeManager.forceRTL).toHaveBeenCalledWith(true);
  });
});
