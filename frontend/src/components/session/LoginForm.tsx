"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { Logo } from "@/components/ui/Logo";
import { auth } from "@/lib/api";

import styles from "./LoginForm.module.css";
import { useSession } from "./SessionProvider";

type Mode = "signin" | "register";

const modeFromUrl = (): Mode =>
  new URLSearchParams(window.location.search).get("mode") === "register" ? "register" : "signin";

// Where to go after signing in: ?next=/leagues?join=CODE from an invite link, or the
// trade screen. Only paths on this site, so the link can't send people elsewhere.
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/trade";
}

export function LoginForm() {
  const router = useRouter();
  const { start, session } = useSession();
  const guestToken = session?.user.role === "guest" ? session.accessToken : undefined;
  const initial = useSyncExternalStore(
    () => () => {},
    modeFromUrl,
    () => "signin" as Mode,
  );
  const [picked, setPicked] = useState<Mode | null>(null);
  const mode = picked ?? initial;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    setBusy(true);
    setError(null);
    try {
      await start(() =>
        mode === "register"
          ? auth.register(email, String(f.get("username")), password, guestToken)
          : auth.login(email, password),
      );
      router.push(nextPath());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <Link href="/" aria-label="Ticker home">
        <Logo />
      </Link>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.modes} role="tablist">
          {(["signin", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setPicked(m)}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
        <label>
          <span className="label">Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        {mode === "register" && (
          <label>
            <span className="label">Username</span>
            <input
              name="username"
              autoComplete="username"
              pattern="[A-Za-z0-9_]{3,24}"
              title="3-24 letters, numbers or underscores"
              required
            />
          </label>
        )}
        <label>
          <span className="label">Password</span>
          <input
            name="password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            minLength={mode === "register" ? 10 : 1}
            required
          />
        </label>
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? "One moment…" : mode === "register" ? "Create account" : "Sign in"}
        </button>
        {error && (
          <p className={`mono ${styles.error}`} role="alert">
            {error}
          </p>
        )}
        <p className={`mono ${styles.alt}`}>
          Just looking? <Link href="/trade?start=guest">Try it with $100k</Link>, no sign-up.
        </p>
      </form>
    </main>
  );
}
