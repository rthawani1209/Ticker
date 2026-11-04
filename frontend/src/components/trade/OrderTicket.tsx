"use client";

import { forwardRef, useState, type FormEvent } from "react";

import { formatMoney, formatPrice, parseDollars } from "@/lib/format";
import { ticketOrder, type Ticket, type TicketType } from "@/lib/ticket";

import styles from "./OrderTicket.module.css";

interface Props {
  symbol: string;
  last: number;
  cash: number | null;
  ticket: Ticket;
  onChange: (t: Ticket) => void;
  onSubmit: (order: Exclude<ReturnType<typeof ticketOrder>, string>) => Promise<string | null>;
}

const TYPES: { value: TicketType; label: string }[] = [
  { value: "limit", label: "Limit" },
  { value: "market", label: "Market" },
  { value: "stop", label: "Stop" },
  { value: "bracket", label: "Bracket" },
];

// The order ticket. The qty input is the ref, so the B and S shortcuts can jump to it.
export const OrderTicket = forwardRef<HTMLInputElement, Props>(function OrderTicket(
  { symbol, last, cash, ticket, onChange, onSubmit },
  qtyRef,
) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Ticket>) => onChange({ ...ticket, ...patch });

  const order = ticketOrder(ticket, symbol);
  const qty = Number(ticket.qty) || 0;
  const px =
    ticket.type === "market"
      ? last
      : ticket.type === "stop"
        ? (parseDollars(ticket.stop) ?? last)
        : (parseDollars(ticket.price) ?? last);
  const cost = qty * px;
  const share = cash && cash > 0 ? Math.min(1, cost / cash) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (typeof order === "string") return setResult({ ok: false, text: order });
    setBusy(true);
    const error = await onSubmit(order);
    setBusy(false);
    setResult(
      error
        ? { ok: false, text: error }
        : { ok: true, text: `Sent: ${ticket.side} ${qty} ${symbol}` },
    );
  };

  const verb = ticket.side === "buy" ? "Buy" : "Sell";
  const at =
    ticket.type === "market"
      ? "at market"
      : ticket.type === "stop"
        ? `stop ${ticket.stop || "—"}`
        : `@ ${ticket.price || "—"}`;

  return (
    <form className={styles.ticket} onSubmit={submit} data-side={ticket.side} noValidate>
      <div className={styles.sides} role="radiogroup" aria-label="Side">
        {(["buy", "sell"] as const).map((side) => (
          <button
            key={side}
            type="button"
            role="radio"
            aria-checked={ticket.side === side}
            className={styles.side}
            data-side={side}
            onClick={() => set({ side })}
          >
            {side}
          </button>
        ))}
      </div>

      <div className={styles.types} role="radiogroup" aria-label="Order type">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={ticket.type === t.value}
            className={styles.type}
            onClick={() => set({ type: t.value })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.fields}>
        {(ticket.type === "limit" || ticket.type === "bracket") && (
          <Field label={ticket.type === "bracket" ? "Entry price" : "Limit price"}>
            <input
              inputMode="decimal"
              value={ticket.price}
              placeholder={formatPrice(last)}
              onChange={(e) => set({ price: e.target.value })}
            />
          </Field>
        )}
        {ticket.type === "stop" && (
          <Field label="Stop price">
            <input
              inputMode="decimal"
              value={ticket.stop}
              placeholder={formatPrice(last)}
              onChange={(e) => set({ stop: e.target.value })}
            />
          </Field>
        )}
        {ticket.type === "market" && (
          <Field label="Price">
            <input value="Market" readOnly tabIndex={-1} />
          </Field>
        )}
        <Field label="Quantity">
          <input
            ref={qtyRef}
            inputMode="numeric"
            value={ticket.qty}
            onChange={(e) => set({ qty: e.target.value.replace(/\D/g, "") })}
          />
        </Field>
        {ticket.type === "bracket" && (
          <>
            <Field label="Take profit">
              <input
                inputMode="decimal"
                value={ticket.takeProfit}
                onChange={(e) => set({ takeProfit: e.target.value })}
              />
            </Field>
            <Field label="Stop loss">
              <input
                inputMode="decimal"
                value={ticket.stopLoss}
                onChange={(e) => set({ stopLoss: e.target.value })}
              />
            </Field>
          </>
        )}
      </div>

      <dl className={`mono ${styles.math}`}>
        <div>
          <dt>Est. {ticket.side === "buy" ? "cost" : "proceeds"}</dt>
          <dd>{formatMoney(cost)}</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd>{cash === null ? "—" : formatMoney(cash)}</dd>
        </div>
      </dl>
      {ticket.side === "buy" && (
        <div className={styles.meter} aria-hidden="true">
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
      {ticket.type === "bracket" && (
        <p className={`mono ${styles.note}`}>
          When the entry fills, a take-profit and a stop-loss go out. The first to fill cancels the
          other.
        </p>
      )}

      <button type="submit" className={styles.submit} disabled={busy}>
        {busy ? "Sending…" : `${verb} ${qty || ""} ${symbol} ${at}`}
      </button>
      <p className={`mono ${styles.result}`} data-ok={result?.ok} role="status" aria-live="polite">
        {result?.text ?? ""}
      </p>
      <p className={`mono ${styles.keys}`}>
        <kbd>B</kbd> buy <kbd>S</kbd> sell <kbd>Esc</kbd> cancel all
      </p>
    </form>
  );
});

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
