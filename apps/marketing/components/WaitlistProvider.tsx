"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { WaitlistDialog } from "@/components/WaitlistDialog";

type WaitlistContextValue = {
  open: () => void;
};

const WaitlistContext = createContext<WaitlistContextValue | null>(null);

export function WaitlistProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo<WaitlistContextValue>(() => ({ open }), [open]);

  return (
    <WaitlistContext.Provider value={value}>
      {children}
      <WaitlistDialog open={isOpen} onClose={close} />
    </WaitlistContext.Provider>
  );
}

export function useWaitlist(): WaitlistContextValue {
  const ctx = useContext(WaitlistContext);
  if (!ctx) {
    throw new Error("useWaitlist must be used inside <WaitlistProvider>");
  }
  return ctx;
}
