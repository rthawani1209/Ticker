"use client";

import { useState } from "react";

import { direction, formatPrice, type Direction } from "@/lib/format";

import styles from "./PriceCell.module.css";

interface Props {
  cents: number;
  className?: string;
}

// A price that flashes green or red for a moment when it changes, so your eye
// catches movement without the number itself jumping around.
export function PriceCell({ cents, className }: Props) {
  const [previous, setPrevious] = useState(cents);
  const [flash, setFlash] = useState<{ dir: Direction; n: number }>({ dir: "flat", n: 0 });

  // Adjusting state while rendering (not in an effect) avoids a frame with the stale color.
  if (cents !== previous) {
    setPrevious(cents);
    setFlash({ dir: direction(cents - previous), n: flash.n + 1 });
  }

  return (
    <span
      // A new key restarts the animation when the price moves the same way twice.
      key={flash.n}
      className={[styles.cell, flash.n > 0 ? styles[flash.dir] : "", className].join(" ")}
      data-direction={flash.dir}
    >
      {formatPrice(cents)}
    </span>
  );
}
