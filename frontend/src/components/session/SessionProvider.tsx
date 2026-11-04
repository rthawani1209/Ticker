"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { auth, type Session } from "@/lib/api";

// The access token lives only in memory; the refresh cookie (httpOnly, set by the API)
// brings it back after a reload. Access tokens last 15 minutes, so refresh at 12.
const REFRESH_MS = 12 * 60 * 1000;

type Status = "loading" | "signed-in" | "signed-out";

interface SessionState {
  status: Status;
  session: Session | null;
  start: (how: () => Promise<Session>) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession needs a <SessionProvider> above it");
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  const apply = useCallback((s: Session | null) => {
    setSession(s);
    setStatus(s ? "signed-in" : "signed-out");
  }, []);

  useEffect(() => {
    auth.refresh().then(apply, () => apply(null));
  }, [apply]);

  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => auth.refresh().then(apply, () => apply(null)), REFRESH_MS);
    return () => clearTimeout(timer);
  }, [session, apply]);

  const start = useCallback(async (how: () => Promise<Session>) => apply(await how()), [apply]);
  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    apply(null);
  }, [apply]);

  return <SessionContext value={{ status, session, start, signOut }}>{children}</SessionContext>;
}
