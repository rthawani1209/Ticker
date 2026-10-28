import styles from "./Logo.module.css";

export function Logo() {
  return (
    <span className={styles.logo}>
      <svg width="24" height="24" viewBox="0 0 22 22" aria-hidden="true">
        <rect x="0.5" y="0.5" width="21" height="21" fill="none" stroke="var(--bracket)" />
        <path
          d="M3 15 L8 15 L10 7 L13 18 L15 11 L19 11"
          fill="none"
          stroke="var(--you)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className={styles.word}>Ticker</span>
    </span>
  );
}
