"use client";

import { useEffect } from "react";
import { emitNetworkReconnected } from "@/lib/network-status";

export function NetworkStatusProvider() {
  useEffect(() => {
    const onOnline = () => emitNetworkReconnected();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return null;
}
