"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { auth, type Session } from "@/lib/api";

import styles from "./SessionGate.module.css";
import { useSession } from "./SessionProvider";

// Renders its children once there's a session, otherwise a way in. Coming from the
// landing page's "Try it with $100k" (?start=guest) makes a guest account straight away.
export function SessionGate({ children }: { children: (session: Session) => ReactNode }) {
  const { status, session, start } = useSession();
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);
  // Signing in comes back here, so an invite link (/leagues?join=CODE) still works.
  const query = useSearchParams().toString();
  const here = usePathname() + (query ? `?${query}` : "");
  const login = `/login?next=${encodeURIComponent(here)}`;

  const startGuest = () =>
    start(auth.guest).catch((e: Error) => setError(e.message || "couldn't reach the market"));

  useEffect(() => {
    if (status !== "signed-out" || tried.current) return;
    if (new URLSearchParams(window.location.search).get("start") !== "guest") return;
    tried.current = true;
    start(auth.guest).catch((e: Error) => setError(e.message || "couldn't reach the market"));
  }, [status, start]);

  if (status === "signed-in" && session) return children(session);

  return (
    <main className={styles.gate}>
      <Logo />
      {status === "loading" ? (
        <p className="label">Opening the market…</p>
      ) : (
        <div className={styles.box}>
          <h1>Trade with $100,000 of pretend money.</h1>
          <p>
            A guest account needs no sign-up. You get the practice portfolio right away; make an
            account later to join leagues.
          </p>
          <Button size="lg" onClick={startGuest}>
            Start with $100k
          </Button>
          <p className="mono">
            Have an account? <Link href={login}>Sign in</Link> or{" "}
            <Link href={`${login}&mode=register`}>create one</Link>
          </p>
          {error && (
            <p className={`mono ${styles.error}`} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
