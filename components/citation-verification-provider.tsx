"use client";

import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

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
  const [verifications, setVerifications] = useState<
    Map<string, CitationVerificationData>
  >(new Map());

  const getVerification = useCallback(
    (messageId: string) => verifications.get(messageId),
    [verifications]
  );

  const setVerification = useCallback(
    (messageId: string, data: CitationVerificationData | undefined) => {
      setVerifications((prev) => {
        const next = new Map(prev);
        if (data === undefined) {
          next.delete(messageId);
        } else {
          next.set(messageId, data);
        }
        return next;
      });
    },
    []
  );

  const value = useMemo(
    () => ({ getVerification, setVerification }),
    [getVerification, setVerification]
  );

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
