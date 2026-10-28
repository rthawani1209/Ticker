import Link from "next/link";
import type { ComponentProps } from "react";

import styles from "./Button.module.css";

type Variant = "buy" | "sell" | "you" | "ghost";

interface Common {
  variant?: Variant;
  size?: "md" | "lg";
}

const classes = (variant: Variant, size: "md" | "lg", extra?: string) =>
  [styles.button, styles[variant], styles[size], extra].join(" ");

// Solid buttons are chamfered; "ghost" is the quiet secondary action.
export function Button({
  variant = "you",
  size = "md",
  className,
  ...rest
}: Common & ComponentProps<"button">) {
  return <button type="button" className={classes(variant, size, className)} {...rest} />;
}

export function ButtonLink({
  variant = "you",
  size = "md",
  className,
  ...rest
}: Common & ComponentProps<typeof Link>) {
  return <Link className={classes(variant, size, className)} {...rest} />;
}
