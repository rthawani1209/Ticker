"use client";

import {
  BaselineSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import styles from "./EquityChart.module.css";

function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { text: v("--text-3"), line: v("--line"), up: v("--up"), down: v("--down") };
}

// The canvas can't do color-mix(), so fade a #rrggbb token with a hex alpha.
const fade = (hex: string, alpha: number) =>
  /^#[0-9a-f]{6}$/i.test(hex)
    ? hex +
      Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")
    : hex;

const fills = (p: ReturnType<typeof palette>) => ({
  topLineColor: p.up,
  topFillColor1: fade(p.up, 0.28),
  topFillColor2: fade(p.up, 0),
  bottomLineColor: p.down,
  bottomFillColor1: fade(p.down, 0),
  bottomFillColor2: fade(p.down, 0.28),
});

// Lightweight Charts wants strictly increasing times in whole seconds.
export function toSeries(history: { at: number; equity: number }[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of history) {
    const time = Math.floor(p.at / 1000) as UTCTimestamp;
    const point = { time, value: p.equity / 100 };
    if (out.length && out.at(-1)!.time >= time) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

// Equity over time, green above the starting cash and red below it.
export function EquityChart({
  history,
  startingCash,
}: {
  history: { at: number; equity: number }[];
  startingCash: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Baseline"> | null>(null);

  useEffect(() => {
    const p = palette();
    const c = createChart(host.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: p.text,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: p.line } },
      rightPriceScale: { borderColor: p.line },
      timeScale: { borderColor: p.line, timeVisible: true },
      localization: { locale: "en-US" },
      handleScroll: false,
      handleScale: false,
    });
    const s = c.addSeries(BaselineSeries, {
      ...fills(p),
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chart.current = c;
    series.current = s;

    const recolor = new MutationObserver(() => {
      const q = palette();
      c.applyOptions({
        layout: { textColor: q.text },
        grid: { horzLines: { color: q.line } },
        rightPriceScale: { borderColor: q.line },
        timeScale: { borderColor: q.line },
      });
      s.applyOptions(fills(q));
    });
    recolor.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      recolor.disconnect();
      c.remove();
    };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({ baseValue: { type: "price", price: startingCash / 100 } });
    series.current?.setData(toSeries(history));
    chart.current?.timeScale().fitContent();
  }, [history, startingCash]);

  return <div ref={host} className={styles.chart} aria-label="Equity over time" role="img" />;
}
