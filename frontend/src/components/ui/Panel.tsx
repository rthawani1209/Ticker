import type { ReactNode } from "react";

import styles from "./Panel.module.css";

interface Props {
  label?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside";
}

// A square panel with hairline borders and corner brackets. Never nest these.
export function Panel({ label, aside, children, className, as: Tag = "section" }: Props) {
  return (
    <Tag className={[styles.panel, className].join(" ")}>
      {(label || aside) && (
        <header className={styles.head}>
          {label && <span className="label">{label}</span>}
          {aside}
        </header>
      )}
      {children}
    </Tag>
  );
}
