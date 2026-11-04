"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ButtonLink } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";

import styles from "./SiteHeader.module.css";

export const REPO = "https://github.com/rthawani1209/Ticker";

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#leagues", label: "Leagues and classes" },
  { href: "#bots", label: "Bots" },
  { href: REPO, label: "GitHub" },
];

// On narrow screens the links fold into a menu button; Escape or picking a link closes it.
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={styles.top}>
      <div className={styles.bar}>
        <Link href="/" aria-label="Ticker home">
          <Logo />
        </Link>
        <nav
          id="site-nav"
          aria-label="Main"
          className={styles.links}
          data-open={open}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <span className={styles.grow} />
        <Link href="/login" className={styles.signin}>
          Sign in
        </Link>
        <ButtonLink href="/trade?start=guest">Try $100k</ButtonLink>
        <button
          ref={button}
          type="button"
          className={styles.menu}
          aria-expanded={open}
          aria-controls="site-nav"
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.burger} aria-hidden="true" data-open={open} />
          <span className="label">{open ? "Close" : "Menu"}</span>
        </button>
      </div>
    </header>
  );
}
