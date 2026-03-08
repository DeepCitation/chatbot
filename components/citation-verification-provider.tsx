"use client";

import type React from "react";
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";

export interface CitationVerificationData {
  verifications: Record<string, unknown>;
  visibleText: string;
  renderedMarkdown: string;
  attachmentIds: string[];
}

type CitationVerificationContextValue = {
  getVerification: (messageId: string) => CitationVerificationData | undefined;
  setVerification: (
    messageId: string,
    data: CitationVerificationData | undefined
  ) => void;
};

const CitationVerificationContext =
  createContext<CitationVerificationContextValue | null>(null);

export function CitationVerificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Use a ref + external store to avoid re-rendering all consumers on every write.
  // Only components that call getVerification for a changed key will re-render.
  const storeRef = useRef(new Map<string, CitationVerificationData>());
  const versionRef = useRef(0);
  const listenersRef = useRef(new Set<() => void>());

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const getSnapshot = useCallback(() => versionRef.current, []);

  // Subscribe to store changes so consumers re-render
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const getVerification = useCallback(
    (messageId: string) => storeRef.current.get(messageId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionRef.current]
  );

  const setVerification = useCallback(
    (messageId: string, data: CitationVerificationData | undefined) => {
      if (data === undefined) {
        storeRef.current.delete(messageId);
      } else {
        storeRef.current.set(messageId, data);
      }
      versionRef.current++;
      for (const listener of listenersRef.current) {
        listener();
      }
    },
    []
  );

  // Stable value — getVerification identity changes with version via dep array
  const value = { getVerification, setVerification };

  return (
    <CitationVerificationContext.Provider value={value}>
      {children}
    </CitationVerificationContext.Provider>
  );
}

export function useCitationVerification() {
  const context = useContext(CitationVerificationContext);
  if (!context) {
    throw new Error(
      "useCitationVerification must be used within a CitationVerificationProvider"
    );
  }
  return context;
}
