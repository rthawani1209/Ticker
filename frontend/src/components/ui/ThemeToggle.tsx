"use client";

import { useSyncExternalStore } from "react";

import styles from "./ThemeToggle.module.css";

type Theme = "dark" | "light";

// The theme is an attribute on <html>, set before first paint by the script in the root
// layout, and remembered in localStorage.
const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, () => "dark" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          // private mode: the choice just won't stick
        }
      }}
    >
      <span className={styles.icon} data-theme={theme} aria-hidden="true" />
    </button>
  );
}
