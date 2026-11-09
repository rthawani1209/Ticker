"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/app/AppHeader";
import { PriceCell } from "@/components/ui/PriceCell";
import { leagues, type League, type NewOrder, type Session, type Side } from "@/lib/api";
import { formatChange, formatPrice } from "@/lib/format";
import { useQueryParam } from "@/lib/query";
import type { Ticket } from "@/lib/ticket";

import { Blotter } from "./Blotter";
import { DepthLadder } from "./DepthLadder";
import { OrderTicket } from "./OrderTicket";
import { PriceChart } from "./PriceChart";
import styles from "./TradeScreen.module.css";
import { useTrading } from "./useTrading";
import { Watchlist } from "./Watchlist";

const BAND = 0.1; // the engine's price band, 1000 bps either side of the last trade

export function TradeScreen({ session }: { session: Session }) {
  const [symbol, setSymbol] = useState("NOVA");
  const [ticket, setTicket] = useState<Ticket>({
    side: "buy",
    type: "limit",
    qty: "10",
    price: "",
    stop: "",
    takeProfit: "",
    stopLoss: "",
  });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const qtyInput = useRef<HTMLInputElement>(null);
  // Which league's portfolio to trade; /trade?league=ID opens straight into one.
  const urlLeague = Number(useQueryParam("league")) || undefined;
  const [league, setLeague] = useState<number | undefined>(urlLeague);
  // Following another ?league= link while this screen is open switches to it.
  const [linked, setLinked] = useState(urlLeague);
  if (linked !== urlLeague) {
    setLinked(urlLeague);
    setLeague(urlLeague);
  }
  const [leagueList, setLeagueList] = useState<League[]>([]);
  const t = useTrading(session.accessToken, symbol, league);

  useEffect(() => {
    if (session.user.role === "guest") return; // guests only have the practice league
    leagues.list(session.accessToken).then(setLeagueList, () => {});
  }, [session]);

  // Only running leagues can take orders.
  const tradable = leagueList.filter(
    (l) =>
      !l.isPractice &&
      new Date(l.startsAt) <= new Date() &&
      (!l.endsAt || new Date(l.endsAt) > new Date()),
  );

  const summary = t.symbols.find((s) => s.ticker === symbol);
  const last = summary?.last ?? 0;
  const change = summary ? formatChange(summary.last, summary.refPrice) : null;
  const mine = t.orders.filter((o) => o.symbol === symbol);

  const pick = (ticker: string) => {
    setSymbol(ticker);
    setTicket((tk) => ({ ...tk, price: "", stop: "", takeProfit: "", stopLoss: "" }));
  };

  const send = useCallback(
    async (order: NewOrder): Promise<string | null> => {
      const r = await t.placeOrder(order);
      if (!r.ok) return r.message ?? "rejected";
      if (r.order?.status === "rejected")
        return `Rejected: ${r.order.rejectReason?.replaceAll("_", " ")}`;
      return null;
    },
    [t],
  );

  // One click on the ladder sends a limit order at that price for the ticket's quantity.
  const ladderTrade = async (side: Side, price: number) => {
    const qty = Number(ticket.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      return setNotice({ ok: false, text: "Set a quantity in the ticket first" });
    }
    setTicket((tk) => ({ ...tk, side, price: formatPrice(price).replace(/,/g, "") }));
    const error = await send({ symbol, side, type: "limit", qty, price });
    setNotice(
      error
        ? { ok: false, text: error }
        : { ok: true, text: `${side} ${qty} @ ${formatPrice(price)} sent` },
    );
  };

  // B and S pick a side and jump to the quantity; Esc cancels your open orders here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = (e.target as HTMLElement).closest("input, textarea, select");
      if (e.key === "Escape") {
        const open = t.orders.filter(
          (o) => o.symbol === symbol && (o.status === "open" || o.status === "partially_filled"),
        );
        if (open.length === 0) return;
        e.preventDefault();
        Promise.all(open.map((o) => t.cancelOrder(o.id))).then((replies) => {
          const failed = replies.filter((r) => !r.ok);
          setNotice(
            failed.length === 0
              ? { ok: true, text: `Cancelled ${open.length} open ${symbol} order(s)` }
              : { ok: false, text: `${failed.length} not cancelled: ${failed[0]!.message}` },
          );
        });
        return;
      }
      if (typing) return;
      const side =
        e.key === "b" || e.key === "B" ? "buy" : e.key === "s" || e.key === "S" ? "sell" : null;
      if (!side) return;
      e.preventDefault();
      setTicket((tk) => ({ ...tk, side }));
      qtyInput.current?.focus();
      qtyInput.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, symbol]);

  const equity = t.portfolio?.equity;

  return (
    <div className={styles.screen}>
      <AppHeader
        session={session}
        equity={equity ?? null}
        accounts={{
          options: [
            { id: undefined, name: "Practice" },
            ...tradable.map((l) => ({ id: l.id, name: l.name })),
          ],
          value: league,
          onChange: setLeague,
        }}
        connected={t.connected}
        className={styles.top}
      />

      <aside className={styles.watch}>
        <Watchlist symbols={t.symbols} active={symbol} onPick={pick} />
      </aside>

      <main className={styles.main}>
        <section className={styles.quote} aria-label={`${symbol} quote`}>
          <div>
            <span className="label">
              {summary?.company ?? symbol} · {summary?.sector ?? ""}
            </span>
            <h1 className={styles.sym}>{symbol}</h1>
          </div>
          <div className={styles.last}>
            {summary && <PriceCell cents={summary.last} className={styles.bigPrice} />}
            {change && (
              <span className="mono" data-direction={change.dir}>
                {summary?.halted ? "HALTED" : change.text}
              </span>
            )}
          </div>
          <dl className={`mono ${styles.stats}`}>
            <div>
              <dt>Bid</dt>
              <dd>{summary?.bid ? formatPrice(summary.bid) : "—"}</dd>
            </div>
            <div>
              <dt>Ask</dt>
              <dd>{summary?.ask ? formatPrice(summary.ask) : "—"}</dd>
            </div>
            <div>
              <dt>Vol</dt>
              <dd>{summary ? summary.volume.toLocaleString("en-US") : "—"}</dd>
            </div>
            <div>
              <dt>Band</dt>
              <dd>
                {last
                  ? `${formatPrice(Math.ceil(last * (1 - BAND)))}–${formatPrice(Math.floor(last * (1 + BAND)))}`
                  : "—"}
              </dd>
            </div>
          </dl>
        </section>
        <div className={styles.chart}>
          <PriceChart bars={t.candles.bars} symbol={symbol} />
        </div>
        <div className={styles.blotter}>
          <Blotter
            portfolio={t.portfolio}
            orders={t.orders}
            fills={t.fills}
            onCancel={(id) =>
              t.cancelOrder(id).then((r) => {
                if (!r.ok) setNotice({ ok: false, text: `Not cancelled: ${r.message}` });
              })
            }
            onPick={pick}
          />
        </div>
      </main>

      <aside className={styles.side}>
        <section className={styles.ladder} aria-label="Depth ladder">
          <div className={styles.panelHead}>
            <span className="label">Ladder · click to trade</span>
            {notice && (
              <span className={`mono ${styles.notice}`} data-ok={notice.ok} role="status">
                {notice.text}
              </span>
            )}
          </div>
          <DepthLadder
            symbol={symbol}
            book={t.book}
            mine={mine}
            qty={Number(ticket.qty) || 0}
            onTrade={ladderTrade}
          />
        </section>
        <section className={styles.ticket} aria-label="Order ticket">
          <OrderTicket
            ref={qtyInput}
            symbol={symbol}
            last={last}
            cash={t.portfolio?.cash ?? null}
            ticket={ticket}
            onChange={setTicket}
            onSubmit={send}
          />
        </section>
      </aside>
    </div>
  );
}
