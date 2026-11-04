"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { Candle } from "@/lib/api";

import styles from "./PriceChart.module.css";

// Lightweight Charts draws on a canvas, so it can't read CSS variables; take the
// current token values when the chart is made and again when the theme flips.
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: v("--text-3"),
    line: v("--line"),
    up: v("--up"),
    down: v("--down"),
    font: v("--font-mono") || "monospace",
  };
}

function options() {
  const p = palette();
  return {
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: p.text,
      fontFamily: getComputedStyle(document.body).getPropertyValue("--font-mono") || p.font,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: { vertLines: { color: p.line }, horzLines: { color: p.line } },
    rightPriceScale: { borderColor: p.line },
    timeScale: { borderColor: p.line, timeVisible: true, secondsVisible: true },
    // pinned: some browsers report locales like "en-US@posix" that Intl rejects
    localization: { locale: "en-US" },
    crosshair: {
      horzLine: { labelBackgroundColor: p.text },
      vertLine: { labelBackgroundColor: p.text },
    },
  };
}

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open / 100,
  high: c.high / 100,
  low: c.low / 100,
  close: c.close / 100,
});

export function PriceChart({ bars, symbol }: { bars: Candle[]; symbol: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const shown = useRef<{ symbol: string; count: number }>({ symbol: "", count: 0 });

  useEffect(() => {
    const c = createChart(host.current!, { ...options(), autoSize: true });
    const p = palette();
    series.current = c.addSeries(CandlestickSeries, {
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chart.current = c;

    const recolor = new MutationObserver(() => {
      const q = palette();
      c.applyOptions(options());
      series.current?.applyOptions({
        upColor: q.up,
        downColor: q.down,
        wickUpColor: q.up,
        wickDownColor: q.down,
      });
    });
    recolor.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      recolor.disconnect();
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // Whole reload when the symbol changes or history arrives; otherwise just the last bar.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const prev = shown.current;
    if (prev.symbol !== symbol || bars.length < prev.count || bars.length - prev.count > 1) {
      s.setData(bars.map(toBar));
      chart.current?.timeScale().scrollToRealTime();
    } else if (bars.length > 0) {
      s.update(toBar(bars.at(-1)!));
    }
    shown.current = { symbol, count: bars.length };
  }, [bars, symbol]);

  return (
    <div className={styles.wrap}>
      <div ref={host} className={styles.chart} />
      {bars.length === 0 && (
        <p className={`mono ${styles.empty}`}>
          No trades in {symbol} yet. Bars start at the first trade.
        </p>
      )}
    </div>
  );
}
