import { act, render } from "@testing-library/react";
import { NETWORK_RECONNECTED_EVENT } from "@/lib/network-status";
import { NetworkStatusProvider } from "./NetworkStatusProvider";

describe("NetworkStatusProvider", () => {
  it("announces browser reconnects independent of the topbar indicator", () => {
    const listener = vi.fn();
    window.addEventListener(NETWORK_RECONNECTED_EVENT, listener);

    render(<NetworkStatusProvider />);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(NETWORK_RECONNECTED_EVENT, listener);
  });
});
