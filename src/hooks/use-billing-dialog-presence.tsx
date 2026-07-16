"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface BillingDialogPresenceContextValue {
  isSidebarBillingDialogOpen: boolean;
  setSidebarBillingDialogOpen: (open: boolean) => void;
}

const BillingDialogPresenceContext =
  createContext<BillingDialogPresenceContextValue>({
    isSidebarBillingDialogOpen: false,
    setSidebarBillingDialogOpen: () => {},
  });

export function BillingDialogPresenceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [isSidebarBillingDialogOpen, setSidebarBillingDialogOpen] =
    useState(false);
  const value = useMemo(
    () => ({ isSidebarBillingDialogOpen, setSidebarBillingDialogOpen }),
    [isSidebarBillingDialogOpen],
  );

  return (
    <BillingDialogPresenceContext.Provider value={value}>
      {children}
    </BillingDialogPresenceContext.Provider>
  );
}

export function useBillingDialogPresence(): BillingDialogPresenceContextValue {
  return useContext(BillingDialogPresenceContext);
}
