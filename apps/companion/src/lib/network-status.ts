import { useEffect, useState } from "react";

export const NETWORK_RECONNECTED_EVENT = "tarmoto:network-reconnected";

export function emitNetworkReconnected(): void {
  window.dispatchEvent(new Event(NETWORK_RECONNECTED_EVENT));
}

export function useNetworkReconnectRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onReconnect = () => setRevision((current) => current + 1);
    window.addEventListener(NETWORK_RECONNECTED_EVENT, onReconnect);
    return () =>
      window.removeEventListener(NETWORK_RECONNECTED_EVENT, onReconnect);
  }, []);

  return revision;
}
