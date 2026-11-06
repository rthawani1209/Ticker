"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSession } from "@/components/session/SessionProvider";
import { Logo } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import type { Session } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import styles from "./AppHeader.module.css";

const LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/leagues", label: "Leagues" },
] as const;

export interface AccountPicker {
  options: { id: number | undefined; name: string }[]; // id undefined = practice
  value: number | undefined;
  onChange: (id: number | undefined) => void;
}

interface Props {
  session: Session;
  equity?: number | null;
  equityLabel?: string;
  accounts?: AccountPicker; // lets the trade screen switch which league it trades in
  connected?: boolean; // only the trade screen has a live socket to report
  className?: string;
}

// The bar across the top of every signed-in screen.
export function AppHeader({
  session,
  equity,
  equityLabel = "practice",
  accounts,
  connected,
  className,
}: Props) {
  const { signOut } = useSession();
  const path = usePathname();
  const guest = session.user.role === "guest";

  return (
    <header className={[styles.top, className].join(" ")}>
      <Link href="/" aria-label="Ticker home" className={styles.home}>
        <Logo />
      </Link>
      <nav aria-label="App" className={styles.nav}>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      {connected !== undefined && (
        <span className={`mono ${styles.conn}`} data-on={connected}>
          <span aria-hidden="true" />
          {connected ? "Live" : "Reconnecting"}
        </span>
      )}
      <span className={styles.grow} />
      {equity !== undefined && (
        <div className={`mono ${styles.equity}`}>
          {accounts && accounts.options.length > 1 ? (
            <label className={styles.account}>
              <span className="label">Equity ·</span>
              <select
                className="label"
                aria-label="League to trade in"
                value={accounts.value ?? ""}
                onChange={(e) =>
                  accounts.onChange(e.target.value ? Number(e.target.value) : undefined)
                }
              >
                {accounts.options.map((o) => (
                  <option key={o.id ?? "practice"} value={o.id ?? ""}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="label">Equity · {equityLabel}</span>
          )}
          <strong>{equity === null ? "—" : formatMoney(equity)}</strong>
        </div>
      )}
      <ThemeToggle />
      <div className={styles.who}>
        <span className="mono">{guest ? "Guest" : session.user.username}</span>
        {guest ? (
          <Link href="/login?mode=register">Save account</Link>
        ) : (
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
